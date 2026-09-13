import { beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkspaceAuthorizationService } from './workspace-authorization.service';

describe('WorkspaceAuthorizationService', () => {
  const prisma = {
    workspace: {
      findUnique: vi.fn(),
    },
    workspaceMembership: {
      findFirst: vi.fn(),
      count: vi.fn(),
    },
  };

  let service: WorkspaceAuthorizationService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new WorkspaceAuthorizationService(prisma as never);
  });

  it('denies access when membership is missing (cross-tenant)', async () => {
    prisma.workspace.findUnique.mockResolvedValue({
      id: 'ws_a',
      status: 'active',
      memberships: [],
    });

    await expect(
      service.assertAccess({ userId: 'user-b', workspaceId: 'ws_a', permission: 'workspace:read' }),
    ).rejects.toSatisfy((err: unknown) => {
      const response =
        err && typeof err === 'object' && 'getResponse' in err
          ? (err as { getResponse: () => unknown }).getResponse()
          : null;
      return (
        typeof response === 'object' &&
        response !== null &&
        (response as { code?: string }).code === 'WORKSPACE_ACCESS_DENIED'
      );
    });
  });

  it('denies billing:manage for member role', async () => {
    prisma.workspace.findUnique.mockResolvedValue({
      id: 'ws_a',
      status: 'active',
      memberships: [{ id: 'm1', role: 'member', status: 'active' }],
    });

    await expect(
      service.assertAccess({
        userId: 'user-1',
        workspaceId: 'ws_a',
        permission: 'billing:manage',
      }),
    ).rejects.toSatisfy((err: unknown) => {
      const response =
        err && typeof err === 'object' && 'getResponse' in err
          ? (err as { getResponse: () => unknown }).getResponse()
          : null;
      return (
        typeof response === 'object' &&
        response !== null &&
        (response as { code?: string }).code === 'WORKSPACE_ACCESS_DENIED'
      );
    });
  });

  it('allows owner billing:manage', async () => {
    prisma.workspace.findUnique.mockResolvedValue({
      id: 'ws_a',
      status: 'active',
      memberships: [{ id: 'm1', role: 'owner', status: 'active' }],
    });

    const ctx = await service.assertAccess({
      userId: 'user-1',
      workspaceId: 'ws_a',
      permission: 'billing:manage',
    });
    expect(ctx.role).toBe('owner');
    expect(ctx.permissions).toContain('billing:manage');
  });
});
