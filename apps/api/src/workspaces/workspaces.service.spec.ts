import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkspacesService } from './workspaces.service';

describe('WorkspacesService', () => {
  const prisma = {
    workspace: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    user: {
      update: vi.fn(),
      findUnique: vi.fn(),
    },
    workspaceMembership: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    workspaceSubscription: {
      findUnique: vi.fn(),
    },
    $transaction: vi.fn(),
    // Decision B: the per-account lock; this account owns no workspace yet.
    $executeRaw: vi.fn(async () => 0),
  };

  const authorization = {
    assertAccess: vi.fn(),
  };

  const entitlements = {
    invalidate: vi.fn(),
    getEntitlements: vi.fn(),
    getPlanId: vi.fn(),
  };

  const usage = {
    getUsageCounters: vi.fn(),
  };

  let service: WorkspacesService;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.workspace.findUnique.mockResolvedValue(null);
    prisma.workspaceMembership.findMany.mockResolvedValue([]);
    (prisma.workspace as unknown as { count: ReturnType<typeof vi.fn> }).count = vi.fn(
      async () => 0,
    );
    prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) =>
      fn(prisma),
    );
    prisma.workspace.create.mockImplementation(
      async ({
        data,
      }: {
        data: {
          name: string;
          slug: string;
          memberships: { create: { role: string; userId: string } };
        };
      }) => ({
        id: 'ws_created',
        name: data.name,
        slug: data.slug,
        status: 'active',
        createdAt: new Date('2026-09-13T00:00:00.000Z'),
        updatedAt: new Date('2026-09-13T00:00:00.000Z'),
        memberships: [data.memberships.create],
      }),
    );
    prisma.user.update.mockResolvedValue({});
    entitlements.getEntitlements.mockResolvedValue({});
    entitlements.getPlanId.mockResolvedValue('free');
    usage.getUsageCounters.mockResolvedValue([]);
    service = new WorkspacesService(
      prisma as never,
      authorization as never,
      entitlements as never,
      usage as never,
    );
  });

  it('creates a workspace with the creator as OWNER', async () => {
    const workspace = await service.create('user-1', { name: 'Acme Team' });

    expect(workspace.id).toBe('ws_created');
    expect(workspace.name).toBe('Acme Team');
    expect(prisma.workspace.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          createdByUserId: 'user-1',
          memberships: {
            create: expect.objectContaining({
              userId: 'user-1',
              role: 'owner',
              status: 'active',
            }),
          },
          subscription: {
            create: expect.objectContaining({
              planId: 'free',
              status: 'active',
            }),
          },
        }),
      }),
    );
    expect(entitlements.invalidate).toHaveBeenCalledWith('ws_created');
  });
});
