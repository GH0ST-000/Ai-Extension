import { createHash, randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { effectiveMaxWorkspaceMembers, getProductPlan } from '@project-x/shared';
import type { WorkspaceInvitation, WorkspaceMembership } from '@project-x/types';

import { EntitlementService } from '../entitlements/entitlements.service';
import { PrismaService } from '../prisma/prisma.service';
import { WorkspaceAuthorizationService } from './workspace-authorization.service';
import { workspaceException } from './workspace.errors';
import type { InviteWorkspaceMemberDto } from './dto/workspaces.dto';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

@Injectable()
export class WorkspaceInvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: WorkspaceAuthorizationService,
    private readonly entitlements: EntitlementService,
  ) {}

  async createInvitation(
    workspaceId: string,
    invitedByUserId: string,
    input: InviteWorkspaceMemberDto,
  ): Promise<WorkspaceInvitation> {
    await this.authorization.assertAccess({
      userId: invitedByUserId,
      workspaceId,
      permission: 'members:invite',
    });

    const email = input.email.toLowerCase();
    const existingMember = await this.prisma.workspaceMembership.findFirst({
      where: {
        workspaceId,
        status: 'active',
        user: { email },
      },
      select: { id: true },
    });
    if (existingMember) {
      throw workspaceException(
        'WORKSPACE_INVITATION_INVALID',
        'User is already a workspace member.',
      );
    }

    await this.assertSeatAvailable(workspaceId);

    const plaintext = randomBytes(32).toString('base64url');
    const tokenHash = hashInviteToken(plaintext);
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

    const row = await this.prisma.workspaceInvitation.create({
      data: {
        workspaceId,
        email,
        role: input.role,
        tokenHash,
        status: 'pending',
        expiresAt,
        invitedByUserId,
      },
    });

    return {
      ...mapInvitation(row),
      token: plaintext,
    };
  }

  async acceptInvitation(token: string, userId: string): Promise<WorkspaceMembership> {
    const tokenHash = hashInviteToken(token);
    const invitation = await this.prisma.workspaceInvitation.findUnique({
      where: { tokenHash },
    });

    if (!invitation || invitation.status === 'revoked') {
      throw workspaceException('WORKSPACE_INVITATION_INVALID', 'Invitation is invalid.');
    }
    if (invitation.status === 'accepted') {
      throw workspaceException(
        'WORKSPACE_INVITATION_ALREADY_USED',
        'Invitation has already been accepted.',
      );
    }
    if (invitation.expiresAt.getTime() < Date.now() || invitation.status === 'expired') {
      throw workspaceException('WORKSPACE_INVITATION_EXPIRED', 'Invitation has expired.');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true },
    });
    if (!user || user.email.toLowerCase() !== invitation.email.toLowerCase()) {
      throw workspaceException(
        'WORKSPACE_INVITATION_INVALID',
        'Invitation email does not match the signed-in user.',
      );
    }

    const workspace = await this.prisma.workspace.findUnique({
      where: { id: invitation.workspaceId },
      select: { id: true, status: true },
    });
    if (!workspace || workspace.status !== 'active') {
      throw workspaceException('WORKSPACE_INACTIVE', 'Workspace is not active.');
    }

    await this.assertSeatAvailable(invitation.workspaceId);

    const membership = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.workspaceMembership.findUnique({
        where: {
          workspaceId_userId: {
            workspaceId: invitation.workspaceId,
            userId,
          },
        },
      });

      let row;
      if (existing) {
        row = await tx.workspaceMembership.update({
          where: { id: existing.id },
          data: {
            role: invitation.role,
            status: 'active',
            joinedAt: existing.joinedAt ?? new Date(),
          },
          include: {
            user: { select: { id: true, email: true, name: true } },
          },
        });
      } else {
        row = await tx.workspaceMembership.create({
          data: {
            workspaceId: invitation.workspaceId,
            userId,
            role: invitation.role,
            status: 'active',
            joinedAt: new Date(),
          },
          include: {
            user: { select: { id: true, email: true, name: true } },
          },
        });
      }

      await tx.workspaceInvitation.update({
        where: { id: invitation.id },
        data: {
          status: 'accepted',
          acceptedByUserId: userId,
        },
      });

      await tx.user.update({
        where: { id: userId },
        data: { lastWorkspaceId: invitation.workspaceId },
      });

      return row;
    });

    return mapMembership(membership);
  }

  private async assertSeatAvailable(workspaceId: string): Promise<void> {
    const entitlements = await this.entitlements.getEntitlements(workspaceId);
    const limit = effectiveMaxWorkspaceMembers(entitlements.maxWorkspaceMembers);
    const used = await this.prisma.workspaceMembership.count({
      where: { workspaceId, status: 'active' },
    });
    const pending = await this.prisma.workspaceInvitation.count({
      where: { workspaceId, status: 'pending', expiresAt: { gt: new Date() } },
    });

    // Seats count active members; pending invites reserve a soft seat when near limit.
    if (used >= limit) {
      const plan = getProductPlan((await this.entitlements.getPlanId(workspaceId)) ?? 'free');
      throw workspaceException(
        'WORKSPACE_MEMBER_LIMIT_REACHED',
        `Workspace member limit reached for the ${plan.name} plan.`,
        { used, limit },
      );
    }

    if (used + pending >= limit) {
      throw workspaceException(
        'WORKSPACE_MEMBER_LIMIT_REACHED',
        'Workspace member limit reached including pending invitations.',
        { used, pending, limit },
      );
    }
  }
}

export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function mapInvitation(row: {
  id: string;
  workspaceId: string;
  email: string;
  role: string;
  status: string;
  expiresAt: Date;
  invitedByUserId: string;
  acceptedByUserId: string | null;
  createdAt: Date;
}): WorkspaceInvitation {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    email: row.email,
    role: row.role as WorkspaceInvitation['role'],
    status: row.status as WorkspaceInvitation['status'],
    expiresAt: row.expiresAt.toISOString(),
    invitedByUserId: row.invitedByUserId,
    ...(row.acceptedByUserId ? { acceptedByUserId: row.acceptedByUserId } : {}),
    createdAt: row.createdAt.toISOString(),
  };
}

function mapMembership(row: {
  id: string;
  workspaceId: string;
  userId: string;
  role: string;
  status: string;
  joinedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  user?: { id: string; email: string; name: string | null };
}): WorkspaceMembership {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    userId: row.userId,
    role: row.role as WorkspaceMembership['role'],
    status: row.status as WorkspaceMembership['status'],
    ...(row.joinedAt ? { joinedAt: row.joinedAt.toISOString() } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(row.user
      ? {
          user: {
            id: row.user.id,
            email: row.user.email,
            name: row.user.name,
          },
        }
      : {}),
  };
}
