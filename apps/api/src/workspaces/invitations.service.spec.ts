import { createHash } from 'node:crypto';

import { HttpException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { InviteWorkspaceMemberDto } from './dto/workspaces.dto';
import { hashInviteToken, WorkspaceInvitationsService } from './invitations.service';

describe('WorkspaceInvitationsService', () => {
  const prisma = {
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
      update: vi.fn(),
      count: vi.fn(),
    },
    workspace: {
      findUnique: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    $transaction: vi.fn(),
  };

  const authorization = {
    assertAccess: vi.fn(),
  };

  const entitlements = {
    getEntitlements: vi.fn(),
    getPlanId: vi.fn(),
  };

  let service: WorkspaceInvitationsService;

  beforeEach(() => {
    vi.clearAllMocks();
    authorization.assertAccess.mockResolvedValue({
      workspaceId: 'ws_1',
      membershipId: 'm_1',
      role: 'owner',
      permissions: [],
    });
    entitlements.getEntitlements.mockResolvedValue({ maxWorkspaceMembers: 10 });
    entitlements.getPlanId.mockResolvedValue('team');
    prisma.workspaceMembership.findFirst.mockResolvedValue(null);
    prisma.workspaceMembership.count.mockResolvedValue(1);
    prisma.workspaceInvitation.count.mockResolvedValue(0);
    prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) =>
      fn(prisma),
    );
    service = new WorkspaceInvitationsService(
      prisma as never,
      authorization as never,
      entitlements as never,
    );
  });

  it('stores a hashed invitation token and returns plaintext once', async () => {
    const now = new Date();
    prisma.workspaceInvitation.create.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'inv_1',
        workspaceId: data.workspaceId,
        email: data.email,
        role: data.role,
        tokenHash: data.tokenHash,
        status: data.status,
        expiresAt: data.expiresAt,
        invitedByUserId: data.invitedByUserId,
        acceptedByUserId: null,
        createdAt: now,
      }),
    );

    const invitation = await service.createInvitation('ws_1', 'user-owner', {
      email: 'new@example.com',
      role: 'member',
    });

    expect(invitation.token).toBeTruthy();
    expect(invitation.token).not.toEqual(
      (prisma.workspaceInvitation.create.mock.calls[0]?.[0] as { data: { tokenHash: string } }).data
        .tokenHash,
    );
    const storedHash = (
      prisma.workspaceInvitation.create.mock.calls[0]?.[0] as { data: { tokenHash: string } }
    ).data.tokenHash;
    expect(storedHash).toBe(hashInviteToken(invitation.token!));
    expect(storedHash).toBe(createHash('sha256').update(invitation.token!).digest('hex'));
    expect(prisma.workspaceInvitation.create.mock.calls[0]?.[0]).not.toEqual(
      expect.objectContaining({
        data: expect.objectContaining({ token: expect.anything() }),
      }),
    );
  });

  it('rejects inviting with role owner at the DTO boundary', async () => {
    const dto = plainToInstance(InviteWorkspaceMemberDto, {
      email: 'owner@example.com',
      role: 'owner',
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'role')).toBe(true);
  });

  it('accepts a valid invitation', async () => {
    const token = 'plaintext-invite-token';
    const tokenHash = hashInviteToken(token);
    prisma.workspaceInvitation.findUnique.mockResolvedValue({
      id: 'inv_1',
      workspaceId: 'ws_1',
      email: 'member@example.com',
      role: 'member',
      tokenHash,
      status: 'pending',
      expiresAt: new Date(Date.now() + 60_000),
      invitedByUserId: 'user-owner',
      acceptedByUserId: null,
    });
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-new',
      email: 'member@example.com',
    });
    prisma.workspace.findUnique.mockResolvedValue({ id: 'ws_1', status: 'active' });
    prisma.workspaceMembership.findUnique.mockResolvedValue(null);
    const joinedAt = new Date();
    prisma.workspaceMembership.create.mockResolvedValue({
      id: 'm_new',
      workspaceId: 'ws_1',
      userId: 'user-new',
      role: 'member',
      status: 'active',
      joinedAt,
      createdAt: joinedAt,
      updatedAt: joinedAt,
      user: { id: 'user-new', email: 'member@example.com', name: null },
    });
    prisma.workspaceInvitation.update.mockResolvedValue({});
    prisma.user.update.mockResolvedValue({});

    const membership = await service.acceptInvitation(token, 'user-new');
    expect(membership.role).toBe('member');
    expect(membership.workspaceId).toBe('ws_1');
    expect(prisma.workspaceInvitation.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'accepted', acceptedByUserId: 'user-new' }),
      }),
    );
  });

  it('rejects expired invitations', async () => {
    const token = 'expired-token';
    prisma.workspaceInvitation.findUnique.mockResolvedValue({
      id: 'inv_exp',
      workspaceId: 'ws_1',
      email: 'member@example.com',
      role: 'member',
      tokenHash: hashInviteToken(token),
      status: 'pending',
      expiresAt: new Date(Date.now() - 1000),
      invitedByUserId: 'user-owner',
      acceptedByUserId: null,
    });

    await expect(service.acceptInvitation(token, 'user-new')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'WORKSPACE_INVITATION_EXPIRED' }),
    });
  });

  it('rejects revoked invitations', async () => {
    const token = 'revoked-token';
    prisma.workspaceInvitation.findUnique.mockResolvedValue({
      id: 'inv_rev',
      workspaceId: 'ws_1',
      email: 'member@example.com',
      role: 'member',
      tokenHash: hashInviteToken(token),
      status: 'revoked',
      expiresAt: new Date(Date.now() + 60_000),
      invitedByUserId: 'user-owner',
      acceptedByUserId: null,
    });

    await expect(service.acceptInvitation(token, 'user-new')).rejects.toBeInstanceOf(HttpException);
    await expect(service.acceptInvitation(token, 'user-new')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'WORKSPACE_INVITATION_INVALID' }),
    });
  });
});
