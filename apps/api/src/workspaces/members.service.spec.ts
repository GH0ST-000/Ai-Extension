import { beforeEach, describe, expect, it, vi } from 'vitest';

import { workspaceException } from './workspace.errors';
import { WorkspaceMembersService } from './members.service';

describe('WorkspaceMembersService (M3)', () => {
  const prisma = {
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
    workspaceMembership: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    workspaceInvitation: { updateMany: vi.fn() },
  };
  const authorization = { assertAccess: vi.fn(), assertNotSoleOwner: vi.fn() };
  const audit = { record: vi.fn() };
  const ownerCtx = { workspaceId: 'ws_1', membershipId: 'm_owner', role: 'owner', permissions: [] };
  const target = (role: string, userId = 'user-target') => ({
    id: 'm_target',
    workspaceId: 'ws_1',
    userId,
    role,
    status: 'active',
    user: { email: 'Target@Example.com' },
  });

  let service: WorkspaceMembersService;

  beforeEach(() => {
    vi.clearAllMocks();
    authorization.assertAccess.mockResolvedValue(ownerCtx);
    authorization.assertNotSoleOwner.mockResolvedValue(undefined);
    prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => unknown) =>
      fn(prisma),
    );
    prisma.workspaceInvitation.updateMany.mockResolvedValue({ count: 1 });
    const now = new Date();
    prisma.workspaceMembership.update.mockResolvedValue({
      ...target('admin'),
      joinedAt: now,
      createdAt: now,
      updatedAt: now,
      user: { id: 'user-target', email: 'target@example.com', name: null },
    });
    service = new WorkspaceMembersService(prisma as never, authorization as never, audit as never);
  });

  it('re-validates the actor INSIDE the transaction (lock-holding tx passed)', async () => {
    prisma.workspaceMembership.findFirst.mockResolvedValue(target('member'));
    await service.changeRole('ws_1', 'user-owner', 'm_target', { role: 'admin' });
    expect(authorization.assertAccess).toHaveBeenLastCalledWith(
      expect.objectContaining({ permission: 'members:manage', tx: prisma }),
    );
  });

  it('role change revokes the target’s pending invitations in the same transaction', async () => {
    prisma.workspaceMembership.findFirst.mockResolvedValue(target('member'));
    await service.changeRole('ws_1', 'user-owner', 'm_target', { role: 'admin' });
    expect(prisma.workspaceInvitation.updateMany).toHaveBeenCalledWith({
      where: {
        workspaceId: 'ws_1',
        status: 'pending',
        email: { equals: 'target@example.com', mode: 'insensitive' },
      },
      data: { status: 'revoked' },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'workspace.member.role_changed', outcome: 'success' }),
    );
  });

  it('removal revokes the removed person’s pending invitations', async () => {
    prisma.workspaceMembership.findFirst.mockResolvedValue(target('member'));
    await service.removeMember('ws_1', 'user-owner', 'm_target');
    expect(prisma.workspaceMembership.update).toHaveBeenCalledWith({
      where: { id: 'm_target' },
      data: { status: 'removed' },
    });
    // Two revocations: invitations addressed TO the removed person, and (F-14) invitations
    // they ISSUED — a removed member leaves no usable invitation behind.
    expect(prisma.workspaceInvitation.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.workspaceInvitation.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: 'ws_1', status: 'pending', invitedByUserId: 'user-target' },
      data: { status: 'revoked' },
    });
  });

  it('[F-14] demoting below the right to invite revokes the invitations that person issued; a promotion does not', async () => {
    prisma.workspaceMembership.findFirst.mockResolvedValue(target('admin'));
    await service.changeRole('ws_1', 'user-owner', 'm_target', { role: 'member' } as never);
    expect(prisma.workspaceInvitation.updateMany).toHaveBeenCalledWith({
      where: { workspaceId: 'ws_1', status: 'pending', invitedByUserId: 'user-target' },
      data: { status: 'revoked' },
    });

    prisma.workspaceInvitation.updateMany.mockClear();
    prisma.workspaceMembership.findFirst.mockResolvedValue(target('member'));
    await service.changeRole('ws_1', 'user-owner', 'm_target', { role: 'admin' } as never);
    expect(
      prisma.workspaceInvitation.updateMany.mock.calls.some(
        (c) => (c[0] as { where: { invitedByUserId?: string } }).where.invitedByUserId,
      ),
    ).toBe(false);
  });

  it.each(['changeRole', 'removeMember'] as const)(
    '%s: the last owner is protected with the in-transaction count',
    async (op) => {
      prisma.workspaceMembership.findFirst.mockResolvedValue(target('owner', 'user-owner'));
      authorization.assertNotSoleOwner.mockRejectedValue(
        workspaceException('WORKSPACE_LAST_OWNER', 'The sole owner cannot leave or be demoted.'),
      );
      const call =
        op === 'changeRole'
          ? service.changeRole('ws_1', 'user-owner', 'm_target', { role: 'member' })
          : service.removeMember('ws_1', 'user-owner', 'm_target');
      await expect(call).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'WORKSPACE_LAST_OWNER' }),
      });
      expect(authorization.assertNotSoleOwner).toHaveBeenCalledWith('ws_1', 'm_target', prisma);
      expect(prisma.workspaceMembership.update).not.toHaveBeenCalled();
      expect(prisma.workspaceInvitation.updateMany).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'workspace.membership.denied', outcome: 'blocked' }),
      );
    },
  );

  it('an admin cannot change an owner, nor their own role', async () => {
    authorization.assertAccess.mockResolvedValue({ ...ownerCtx, role: 'admin' });
    prisma.workspaceMembership.findFirst.mockResolvedValue(target('owner'));
    await expect(
      service.changeRole('ws_1', 'user-admin', 'm_target', { role: 'member' }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'WORKSPACE_ACCESS_DENIED' }),
    });
    prisma.workspaceMembership.findFirst.mockResolvedValue(target('admin', 'user-admin'));
    await expect(
      service.changeRole('ws_1', 'user-admin', 'm_target', { role: 'member' }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'WORKSPACE_ACCESS_DENIED' }),
    });
    expect(prisma.workspaceMembership.update).not.toHaveBeenCalled();
  });

  it('owner role cannot be granted by a role change', async () => {
    await expect(
      service.changeRole('ws_1', 'user-owner', 'm_target', { role: 'owner' as never }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'WORKSPACE_ACCESS_DENIED' }),
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
