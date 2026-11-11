import { HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

import { RequestContextMiddleware } from '../observability/request-context.middleware';
import {
  RequestContextService,
  type RequestContextStore,
} from '../observability/request-context.service';
import { resolveWorkspaceIdForUser } from './resolve-workspace-id';

type Membership = { workspaceId: string; userId: string; role: string; active: boolean };

/** Minimal prisma double: memberships are "active" only when member + workspace are active. */
function prismaWith(memberships: Membership[], lastWorkspaceId: string | null = null) {
  const findFirst = vi.fn(
    async (args: { where: { workspaceId?: string; userId: string; role?: string } }) => {
      const hit = memberships.find(
        (m) =>
          m.active &&
          m.userId === args.where.userId &&
          (args.where.workspaceId === undefined || m.workspaceId === args.where.workspaceId) &&
          (args.where.role === undefined || m.role === args.where.role),
      );
      return hit ? { workspaceId: hit.workspaceId } : null;
    },
  );
  return {
    prisma: {
      workspaceMembership: { findFirst },
      user: { findUnique: vi.fn(async () => ({ lastWorkspaceId })) },
    } as never,
    findFirst,
  };
}

const ctx = new RequestContextService();
const inRequest = <T>(store: Partial<RequestContextStore>, fn: () => Promise<T>) =>
  ctx.run({ requestId: 'r', ...store }, fn);

async function errorOf(p: Promise<unknown>): Promise<{ status: number; code: unknown }> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(HttpException);
    const e = err as HttpException;
    return { status: e.getStatus(), code: (e.getResponse() as { code?: unknown }).code };
  }
  throw new Error('expected rejection');
}

const MEMBER_OF_A: Membership[] = [
  { workspaceId: 'ws_a', userId: 'u1', role: 'owner', active: true },
  { workspaceId: 'ws_b', userId: 'u1', role: 'member', active: true },
];

describe('resolveWorkspaceIdForUser — explicit workspace selection', () => {
  it('returns the requested workspace when the user is an active member', async () => {
    const { prisma } = prismaWith(MEMBER_OF_A, 'ws_a');
    await expect(
      inRequest({ workspaceId: 'ws_b' }, () => resolveWorkspaceIdForUser(prisma, 'u1')),
    ).resolves.toBe('ws_b');
  });

  it.each([
    ['nonexistent workspace', 'ws_does_not_exist'],
    ['foreign workspace (not a member)', 'ws_foreign'],
  ])('rejects a %s header with 403 instead of falling back', async (_label, header) => {
    const { prisma } = prismaWith(MEMBER_OF_A, 'ws_a');
    const err = await errorOf(
      inRequest({ workspaceId: header }, () => resolveWorkspaceIdForUser(prisma, 'u1')),
    );
    expect(err).toEqual({ status: 403, code: 'WORKSPACE_CONTEXT_UNAVAILABLE' });
  });

  it('rejects a stale header (membership removed / workspace inactive) with 403', async () => {
    const { prisma } = prismaWith(
      [
        { workspaceId: 'ws_a', userId: 'u1', role: 'owner', active: true },
        { workspaceId: 'ws_left', userId: 'u1', role: 'admin', active: false },
      ],
      'ws_a',
    );
    const err = await errorOf(
      inRequest({ workspaceId: 'ws_left' }, () => resolveWorkspaceIdForUser(prisma, 'u1')),
    );
    expect(err.code).toBe('WORKSPACE_CONTEXT_UNAVAILABLE');
  });

  it('rejects a malformed header with 400 instead of treating it as absent', async () => {
    const { prisma, findFirst } = prismaWith(MEMBER_OF_A, 'ws_a');
    const err = await errorOf(
      inRequest({ workspaceHeaderInvalid: true }, () => resolveWorkspaceIdForUser(prisma, 'u1')),
    );
    expect(err).toEqual({ status: 400, code: 'WORKSPACE_ID_INVALID' });
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('applies the same rule to an explicit workspace id argument', async () => {
    const { prisma } = prismaWith(MEMBER_OF_A, 'ws_a');
    const err = await errorOf(resolveWorkspaceIdForUser(prisma, 'u1', 'ws_foreign'));
    expect(err.code).toBe('WORKSPACE_CONTEXT_UNAVAILABLE');
  });
});

describe('resolveWorkspaceIdForUser — header absent (documented fallback preserved)', () => {
  it('uses lastWorkspaceId when it is still an active membership', async () => {
    const { prisma } = prismaWith(MEMBER_OF_A, 'ws_b');
    await expect(inRequest({}, () => resolveWorkspaceIdForUser(prisma, 'u1'))).resolves.toBe(
      'ws_b',
    );
  });

  it('falls back to the oldest owned workspace when lastWorkspaceId is stale', async () => {
    const { prisma } = prismaWith(MEMBER_OF_A, 'ws_gone');
    await expect(inRequest({}, () => resolveWorkspaceIdForUser(prisma, 'u1'))).resolves.toBe(
      'ws_a',
    );
  });

  it('falls back to the personal workspace id convention as a last resort', async () => {
    const { prisma } = prismaWith([], null);
    await expect(resolveWorkspaceIdForUser(prisma, 'u9')).resolves.toBe('ws_u9');
  });

  it('treats a blank explicit argument as absent', async () => {
    const { prisma } = prismaWith(MEMBER_OF_A, 'ws_a');
    await expect(resolveWorkspaceIdForUser(prisma, 'u1', '   ')).resolves.toBe('ws_a');
  });
});

describe('RequestContextMiddleware — X-Workspace-Id parsing', () => {
  function storeFor(header: string | undefined): RequestContextStore | undefined {
    const service = new RequestContextService();
    const middleware = new RequestContextMiddleware(
      service,
      { shouldSample: () => false } as never,
      { get: () => undefined } as never,
    );
    let seen: RequestContextStore | undefined;
    const req = {
      header: (name: string) => (name.toLowerCase() === 'x-workspace-id' ? header : undefined),
    } as unknown as Request;
    const res = { setHeader: vi.fn() } as unknown as Response;
    const next: NextFunction = () => {
      seen = { ...service.get()! };
    };
    middleware.use(req, res, next);
    return seen;
  }

  it('records a well-formed header (trimmed)', () => {
    const s = storeFor('  ws_abc-123 ');
    expect(s?.workspaceId).toBe('ws_abc-123');
    expect(s?.workspaceHeaderInvalid).toBeUndefined();
  });

  it.each([['ws/../x'], ['has space'], ['x'.repeat(65)], ["ws_a' OR 1=1"]])(
    'flags malformed header %j and does not set workspaceId',
    (header) => {
      const s = storeFor(header);
      expect(s?.workspaceId).toBeUndefined();
      expect(s?.workspaceHeaderInvalid).toBe(true);
    },
  );

  it.each([[undefined], [''], ['   ']])('treats %j as absent', (header) => {
    const s = storeFor(header);
    expect(s?.workspaceId).toBeUndefined();
    expect(s?.workspaceHeaderInvalid).toBeUndefined();
  });
});
