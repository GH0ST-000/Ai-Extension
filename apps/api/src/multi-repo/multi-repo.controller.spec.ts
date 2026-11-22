import { GUARDS_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';

import { ResolvedWorkspacePermissionGuard } from '../workspaces/resolved-workspace-permission.guard';
import { WORKSPACE_PERMISSION_KEY } from '../workspaces/workspace.decorators';
import { MultiRepoController } from './multi-repo.controller';

/** M4: the expected permission of every Systems route (by handler name). */
const EXPECTED: Record<string, 'systems:read' | 'systems:manage'> = {
  list: 'systems:read',
  get: 'systems:read',
  listRelationships: 'systems:read',
  context: 'systems:read',
  refresh: 'systems:read', // product decision: discovery stores only the caller's own findings
  discover: 'systems:read',
  analyzeImpact: 'systems:read',
  traceFlow: 'systems:read',
  compareRequirement: 'systems:read',
  findApiConsumers: 'systems:read',
  findEventConsumers: 'systems:read',
  create: 'systems:manage',
  update: 'systems:manage',
  delete: 'systems:manage',
  addRepository: 'systems:manage',
  updateRepository: 'systems:manage',
  removeRepository: 'systems:manage',
};

describe('MultiRepoController permissions (M4)', () => {
  const proto = MultiRepoController.prototype as unknown as Record<string, () => unknown>;
  const routes = Object.getOwnPropertyNames(proto).filter(
    (name) =>
      name !== 'constructor' && Reflect.getMetadata(METHOD_METADATA, proto[name]!) !== undefined,
  );

  it('every route declares exactly the expected permission (no unannotated route)', () => {
    expect(routes.sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const name of routes) {
      expect([name, Reflect.getMetadata(WORKSPACE_PERMISSION_KEY, proto[name]!)]).toEqual([
        name,
        EXPECTED[name],
      ]);
    }
  });

  it('the permission guard is applied to the whole controller', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, MultiRepoController) as unknown[];
    expect(guards).toContain(ResolvedWorkspacePermissionGuard);
  });
});

describe('ResolvedWorkspacePermissionGuard (M4)', () => {
  const context = (user: unknown, handler: () => void) =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ user, headers: {} }) }),
      getHandler: () => handler,
      getClass: () => class {},
    }) as never;

  function guardWith(assertAccess = vi.fn(async () => ({ role: 'member' }))) {
    const prisma = {
      user: { findUnique: vi.fn(async () => ({ lastWorkspaceId: 'ws_1' })) },
      workspaceMembership: { findFirst: vi.fn(async () => ({ workspaceId: 'ws_1' })) },
    };
    return {
      guard: new ResolvedWorkspacePermissionGuard(
        new Reflector(),
        prisma as never,
        { assertAccess } as never,
      ),
      assertAccess,
    };
  }

  it('checks the declared permission in the resolved workspace', async () => {
    const handler = () => undefined;
    Reflect.defineMetadata(WORKSPACE_PERMISSION_KEY, 'systems:manage', handler);
    const { guard, assertAccess } = guardWith();
    await expect(guard.canActivate(context({ id: 'u1' }, handler))).resolves.toBe(true);
    expect(assertAccess).toHaveBeenCalledWith({
      userId: 'u1',
      workspaceId: 'ws_1',
      permission: 'systems:manage',
    });
  });

  it('fails closed without a declared permission or without a user', async () => {
    const { guard, assertAccess } = guardWith();
    await expect(guard.canActivate(context({ id: 'u1' }, () => undefined))).rejects.toMatchObject({
      status: 403,
    });
    const handler = () => undefined;
    Reflect.defineMetadata(WORKSPACE_PERMISSION_KEY, 'systems:read', handler);
    await expect(guard.canActivate(context(undefined, handler))).rejects.toMatchObject({
      status: 403,
    });
    expect(assertAccess).not.toHaveBeenCalled();
  });

  it('propagates RBAC refusals', async () => {
    const handler = () => undefined;
    Reflect.defineMetadata(WORKSPACE_PERMISSION_KEY, 'systems:manage', handler);
    const denied = Object.assign(new Error('denied'), { status: 403 });
    const { guard } = guardWith(vi.fn(async () => Promise.reject(denied)));
    await expect(guard.canActivate(context({ id: 'u1' }, handler))).rejects.toBe(denied);
  });
});
