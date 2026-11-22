import { createHash } from 'node:crypto';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InviteWorkspaceMemberDto } from './dto/workspaces.dto';
import { hashInviteToken, WorkspaceInvitationsService } from './invitations.service';

/**
 * Unit coverage of the decision logic. Locking, concurrency and the real database behaviour
 * are covered by test/integration/workspace-invitations.pg.spec.ts.
 */
describe('WorkspaceInvitationsService (M3)', () => {
  const prisma = {
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
    workspaceMembership: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    workspaceInvitation: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    user: { findUnique: vi.fn(), update: vi.fn() },
  };
  const authorization = { assertAccess: vi.fn() };
  const entitlements = { getEntitlements: vi.fn(), getPlanId: vi.fn() };
  const audit = { record: vi.fn() };
  const token = 'plaintext-invite-token';
  const now = new Date();
  const invitation = (over: Record<string, unknown> = {}) => ({
    id: 'inv_1',
    workspaceId: 'ws_1',
    email: 'member@example.com',
    role: 'member',
    tokenHash: hashInviteToken(token),
    status: 'pending',
    expiresAt: new Date(Date.now() + 60_000),
    invitedByUserId: 'user-owner',
    acceptedByUserId: null,
    createdAt: new Date(Date.now() - 1000),
    ...over,
  });
  const membership = (over: Record<string, unknown> = {}) => ({
    id: 'm_1',
    workspaceId: 'ws_1',
    userId: 'user-new',
    role: 'member',
    status: 'active',
    joinedAt: now,
    createdAt: now,
    updatedAt: now,
    user: { id: 'user-new', email: 'member@example.com', name: null },
    ...over,
  });

  let service: WorkspaceInvitationsService;

  /**
   * The membership lookup, evaluated on its `where`: `acceptor` is what the ACCEPTING user
   * (user-new) has in the workspace; the inviter (user-owner) is an active owner unless
   * `inviter` says otherwise. (F-14: acceptance re-checks the inviter's authority.)
   */
  function existingMembership(
    acceptor: ReturnType<typeof membership> | null,
    inviter: { role: string; status: string } | null = { role: 'owner', status: 'active' },
  ) {
    prisma.workspaceMembership.findUnique.mockImplementation(
      async (args: { where: { workspaceId_userId: { userId: string } } }) =>
        args.where.workspaceId_userId.userId === 'user-owner' ? inviter : acceptor,
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
    authorization.assertAccess.mockResolvedValue({ role: 'owner' });
    entitlements.getEntitlements.mockResolvedValue({ maxWorkspaceMembers: 10 });
    entitlements.getPlanId.mockResolvedValue('team');
    prisma.$queryRaw.mockResolvedValue([{ status: 'active' }]);
    prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => unknown) =>
      fn(prisma),
    );
    prisma.workspaceMembership.findFirst.mockResolvedValue(null);
    existingMembership(null);
    prisma.workspaceMembership.count.mockResolvedValue(1);
    prisma.workspaceInvitation.count.mockResolvedValue(0);
    prisma.workspaceInvitation.updateMany.mockResolvedValue({ count: 0 });
    prisma.workspaceInvitation.findUnique.mockResolvedValue(invitation());
    prisma.workspaceInvitation.findUniqueOrThrow.mockResolvedValue(invitation());
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-new',
      email: 'Member@Example.com',
      emailVerifiedAt: new Date(),
    });
    prisma.workspaceMembership.create.mockResolvedValue(membership());
    service = new WorkspaceInvitationsService(
      prisma as never,
      authorization as never,
      entitlements as never,
      audit as never,
    );
  });

  it('stores only a hash of the token, returns plaintext once, and supersedes older links', async () => {
    prisma.workspaceInvitation.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        ...invitation(),
        ...data,
        acceptedByUserId: null,
        createdAt: now,
      }),
    );
    const created = await service.createInvitation('ws_1', 'user-owner', {
      email: 'New@Example.com',
      role: 'member',
    });
    const data = (
      prisma.workspaceInvitation.create.mock.calls[0]![0] as { data: Record<string, unknown> }
    ).data;
    expect(data.tokenHash).toBe(createHash('sha256').update(created.token!).digest('hex'));
    expect(data).not.toHaveProperty('token');
    expect(data.email).toBe('new@example.com');
    expect(prisma.workspaceInvitation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'revoked' } }),
    );
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain(created.token!);
  });

  it('rejects inviting with role owner at the DTO boundary', async () => {
    const dto = plainToInstance(InviteWorkspaceMemberDto, {
      email: 'o@example.com',
      role: 'owner',
    });
    expect((await validate(dto)).some((e) => e.property === 'role')).toBe(true);
  });

  it('accepts a valid invitation for a new member', async () => {
    const result = await service.acceptInvitation(token, 'user-new');
    expect(result).toMatchObject({ role: 'member', workspaceId: 'ws_1', alreadyMember: false });
    expect(prisma.$queryRaw).toHaveBeenCalled(); // workspace membership lock taken
    expect(prisma.workspaceInvitation.update).toHaveBeenCalledWith({
      where: { id: 'inv_1' },
      data: { status: 'accepted', acceptedByUserId: 'user-new' },
    });
  });

  it.each([
    ['expired', { expiresAt: new Date(Date.now() - 1000) }, 'WORKSPACE_INVITATION_EXPIRED'],
    ['revoked', { status: 'revoked' }, 'WORKSPACE_INVITATION_INVALID'],
    [
      'accepted by someone else',
      { status: 'accepted', acceptedByUserId: 'x' },
      'WORKSPACE_INVITATION_ALREADY_USED',
    ],
  ])('rejects a %s invitation without changing membership', async (_n, over, code) => {
    prisma.workspaceInvitation.findUniqueOrThrow.mockResolvedValue(invitation(over));
    await expect(service.acceptInvitation(token, 'user-new')).rejects.toMatchObject({
      response: expect.objectContaining({ code }),
    });
    expect(prisma.workspaceMembership.create).not.toHaveBeenCalled();
    expect(prisma.workspaceMembership.update).not.toHaveBeenCalled();
  });

  it('Decision A: an unverified account is refused before any lock or state change', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-new',
      email: 'member@example.com',
      emailVerifiedAt: null,
    });
    await expect(service.acceptInvitation(token, 'user-new')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'EMAIL_NOT_VERIFIED' }),
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('wrong user: rejected before any state is revealed', async () => {
    prisma.user.findUnique.mockResolvedValue({ id: 'other', email: 'other@example.com' });
    await expect(service.acceptInvitation(token, 'other')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'WORKSPACE_INVITATION_INVALID' }),
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    ['owner', 'member'],
    ['owner', 'admin'],
    ['admin', 'member'],
    ['member', 'admin'],
  ])('an existing %s is never changed by a %s invitation', async (currentRole, invitedRole) => {
    prisma.workspaceInvitation.findUniqueOrThrow.mockResolvedValue(
      invitation({ role: invitedRole }),
    );
    existingMembership(membership({ role: currentRole }));
    const result = await service.acceptInvitation(token, 'user-new');
    expect(result).toMatchObject({ role: currentRole, alreadyMember: true });
    expect(prisma.workspaceMembership.update).not.toHaveBeenCalled();
    expect(prisma.workspaceMembership.create).not.toHaveBeenCalled();
    expect(prisma.workspaceInvitation.update).toHaveBeenCalledWith({
      where: { id: 'inv_1' },
      data: { status: 'revoked' },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'workspace.membership.denied', outcome: 'blocked' }),
    );
  });

  it('a removal after the invitation was issued cannot be undone by it', async () => {
    existingMembership(membership({ status: 'removed', updatedAt: new Date() }));
    await expect(service.acceptInvitation(token, 'user-new')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'WORKSPACE_INVITATION_INVALID' }),
    });
    expect(prisma.workspaceMembership.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'active' }) }),
    );
  });

  it.each(['deletion_pending', 'deleted'])('a %s workspace refuses acceptance', async (status) => {
    prisma.$queryRaw.mockResolvedValue([{ status }]);
    await expect(service.acceptInvitation(token, 'user-new')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'WORKSPACE_INACTIVE' }),
    });
    expect(prisma.workspaceMembership.create).not.toHaveBeenCalled();
  });

  it('list responses contain no token and no token hash', async () => {
    prisma.workspaceInvitation.findMany.mockResolvedValue([invitation()]);
    const list = await service.listInvitations('ws_1', 'user-owner');
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(hashInviteToken(token));
    expect(list[0]).not.toHaveProperty('token');
    expect(list[0]).not.toHaveProperty('tokenHash');
  });

  it.each([
    ['was removed', { role: 'admin', status: 'removed' }],
    ['was demoted to member', { role: 'member', status: 'active' }],
    ['is not a member at all', null],
    ['has an unknown role', { role: 'superuser', status: 'active' }],
  ])('[F-14] an invitation whose inviter %s is refused and retired', async (_name, inviter) => {
    existingMembership(null, inviter);
    await expect(service.acceptInvitation(token, 'user-new')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'WORKSPACE_INVITATION_INVALID' }),
    });
    expect(prisma.workspaceMembership.create).not.toHaveBeenCalled();
    expect(prisma.workspaceInvitation.update).toHaveBeenCalledWith({
      where: { id: 'inv_1' },
      data: { status: 'revoked' },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'workspace.membership.denied',
        outcome: 'blocked',
        detail: expect.stringContaining('result=inviter_no_longer_authorized'),
      }),
    );
  });
});
