import { createHash, randomBytes } from 'node:crypto';

import { Injectable, Logger, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { effectiveMaxWorkspaceMembers, getProductPlan, roleHasPermission } from '@project-x/shared';
import type {
  AcceptWorkspaceInvitationResponse,
  WorkspaceInvitation,
  WorkspaceMembership,
  WorkspaceRole,
} from '@project-x/types';

import { EntitlementService } from '../entitlements/entitlements.service';
import { SecurityAuditService } from '../observability/security-audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { WorkspaceAuthorizationService } from './workspace-authorization.service';
import { recordWorkspaceAudit, recordWorkspaceDenial } from './workspace-audit';
import { lockWorkspaceMembership, revokePendingInvitationsFor } from './workspace-membership-lock';
import { workspaceException } from './workspace.errors';
import type { InviteWorkspaceMemberDto } from './dto/workspaces.dto';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MEMBER_WITH_USER = { user: { select: { id: true, email: true, name: true } } } as const;

type SeatLimit = { limit: number; planName: string };

/**
 * Invitation lifecycle (M3). States: pending → accepted | revoked (expiry is time-based).
 *
 * - Every change runs in one transaction under the workspace membership lock
 *   (lockWorkspaceMembership), the same lock as role changes, removals, ownership transfer and
 *   (via the workspace row) deletion, and re-validates everything under it.
 * - An invitation only ever ADDS a person who is not an active member. It never changes the
 *   role of an existing membership (no promotion, no demotion, no owner change).
 * - Removal, role change and ownership transfer revoke the person's pending invitations in the
 *   same transaction; an invitation issued before a removal can never reactivate it.
 * - Tokens are stored only as SHA-256 hashes and never logged, listed or put in errors.
 */
@Injectable()
export class WorkspaceInvitationsService {
  private readonly logger = new Logger(WorkspaceInvitationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: WorkspaceAuthorizationService,
    private readonly entitlements: EntitlementService,
    @Optional() private readonly audit?: SecurityAuditService,
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
    const seats = await this.seatLimit(workspaceId);
    const plaintext = randomBytes(32).toString('base64url');
    const tokenHash = hashInviteToken(plaintext);
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

    const { row, superseded } = await this.prisma.$transaction(async (tx) => {
      await this.authorization.assertAccess({
        userId: invitedByUserId,
        workspaceId,
        permission: 'members:invite',
        tx,
      });
      const existingMember = await tx.workspaceMembership.findFirst({
        where: {
          workspaceId,
          status: 'active',
          user: { email: { equals: email, mode: 'insensitive' } },
        },
        select: { id: true },
      });
      if (existingMember) {
        throw workspaceException(
          'WORKSPACE_INVITATION_INVALID',
          'User is already a workspace member.',
        );
      }
      // One live invitation per person: a new one replaces (revokes) the previous links.
      const replaced = await revokePendingInvitationsFor(tx, workspaceId, email);
      await this.assertSeatAvailable(tx, workspaceId, seats, { reservePending: true });
      const created = await tx.workspaceInvitation.create({
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
      return { row: created, superseded: replaced };
    });

    recordWorkspaceAudit(this.audit, this.logger, {
      type: 'workspace.invitation.created',
      outcome: 'success',
      actorUserId: invitedByUserId,
      workspaceId,
      action: 'create_invitation',
      targetId: row.id,
      detail: `role=${row.role} superseded=${superseded}`,
    });

    return {
      ...mapInvitation(row),
      token: plaintext,
    };
  }

  /** Pending, unexpired invitations of the workspace. Never contains tokens or their hashes. */
  async listInvitations(workspaceId: string, userId: string): Promise<WorkspaceInvitation[]> {
    await this.authorization.assertAccess({
      userId,
      workspaceId,
      permission: 'members:invite',
    });
    const rows = await this.prisma.workspaceInvitation.findMany({
      where: { workspaceId, status: 'pending', expiresAt: { gt: new Date() } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 200,
    });
    return rows.map(mapInvitation);
  }

  /**
   * Revokes a pending invitation of this workspace. Idempotent: revoking a revoked (or expired)
   * invitation succeeds without change. An invitation of another workspace is "not found".
   */
  async revokeInvitation(workspaceId: string, userId: string, invitationId: string): Promise<void> {
    const auditTarget = {
      actorUserId: userId,
      workspaceId,
      action: 'revoke_invitation',
      targetId: invitationId,
    };
    try {
      await this.authorization.assertAccess({
        userId,
        workspaceId,
        permission: 'members:invite',
      });
      const changed = await this.prisma.$transaction(async (tx) => {
        await this.authorization.assertAccess({
          userId,
          workspaceId,
          permission: 'members:invite',
          tx,
        });
        const invitation = await tx.workspaceInvitation.findFirst({
          where: { id: invitationId, workspaceId },
          select: { id: true, status: true },
        });
        if (!invitation) {
          throw workspaceException('WORKSPACE_INVITATION_NOT_FOUND', 'Invitation not found.');
        }
        if (invitation.status === 'accepted') {
          throw workspaceException(
            'WORKSPACE_INVITATION_ALREADY_USED',
            'Invitation has already been accepted. Manage the membership instead.',
          );
        }
        if (invitation.status !== 'pending') return false;
        await tx.workspaceInvitation.update({
          where: { id: invitation.id },
          data: { status: 'revoked' },
        });
        return true;
      });
      if (changed) {
        recordWorkspaceAudit(this.audit, this.logger, {
          ...auditTarget,
          type: 'workspace.invitation.revoked',
          outcome: 'success',
        });
      }
    } catch (error) {
      recordWorkspaceDenial(this.audit, this.logger, error, auditTarget);
      throw error;
    }
  }

  async acceptInvitation(
    token: string,
    userId: string,
  ): Promise<AcceptWorkspaceInvitationResponse> {
    const tokenHash = hashInviteToken(token);
    const invitation = await this.prisma.workspaceInvitation.findUnique({
      where: { tokenHash },
      select: { id: true, workspaceId: true, email: true },
    });
    if (!invitation) {
      throw workspaceException('WORKSPACE_INVITATION_INVALID', 'Invitation is invalid.');
    }

    // Identity first: someone else's link reveals nothing about its state or workspace.
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, emailVerifiedAt: true },
    });
    if (!user || user.email.toLowerCase() !== invitation.email.toLowerCase()) {
      throw workspaceException(
        'WORKSPACE_INVITATION_INVALID',
        'Invitation email does not match the signed-in user.',
      );
    }
    // Decision A: an email string is not proof of identity. Only an account that VERIFIED
    // control of the invited address may accept (the invitation stays pending until then).
    if (!user.emailVerifiedAt) {
      throw workspaceException(
        'EMAIL_NOT_VERIFIED',
        'Confirm your email address before accepting this invitation. We sent you a verification link — you can request a new one.',
      );
    }

    const seats = await this.seatLimit(invitation.workspaceId);

    const outcome = await this.prisma.$transaction(async (tx) => {
      const workspaceStatus = await lockWorkspaceMembership(tx, invitation.workspaceId);
      if (workspaceStatus !== 'active') {
        throw workspaceException('WORKSPACE_INACTIVE', 'Workspace is not active.');
      }
      // Re-read under the lock: a concurrent revoke / removal / acceptance has committed.
      const current = await tx.workspaceInvitation.findUniqueOrThrow({
        where: { id: invitation.id },
      });
      const existing = await tx.workspaceMembership.findUnique({
        where: { workspaceId_userId: { workspaceId: current.workspaceId, userId } },
        include: MEMBER_WITH_USER,
      });

      if (current.status === 'accepted') {
        // Duplicate submission of the same acceptance: answer it again, change nothing.
        if (current.acceptedByUserId === userId && existing?.status === 'active') {
          return { kind: 'replayed' as const, membership: existing };
        }
        throw workspaceException(
          'WORKSPACE_INVITATION_ALREADY_USED',
          'Invitation has already been accepted.',
        );
      }
      if (current.status !== 'pending') {
        throw workspaceException('WORKSPACE_INVITATION_INVALID', 'Invitation is invalid.');
      }
      if (current.expiresAt.getTime() <= Date.now()) {
        throw workspaceException('WORKSPACE_INVITATION_EXPIRED', 'Invitation has expired.');
      }
      // F-14: an invitation carries its inviter's authority and no more. If the inviter is no
      // longer an active member who may invite (removed, left, demoted — by any path, also
      // ones that predate the revocation on removal), the invitation is void.
      const inviter = await tx.workspaceMembership.findUnique({
        where: {
          workspaceId_userId: { workspaceId: current.workspaceId, userId: current.invitedByUserId },
        },
        select: { role: true, status: true },
      });
      const inviterMayInvite =
        inviter?.status === 'active' &&
        ['owner', 'admin', 'member'].includes(inviter.role) &&
        roleHasPermission(inviter.role as WorkspaceRole, 'members:invite');
      if (!inviterMayInvite) {
        await tx.workspaceInvitation.update({
          where: { id: current.id },
          data: { status: 'revoked' },
        });
        return { kind: 'inviter_unauthorized' as const };
      }

      if (existing?.status === 'active') {
        // Never promote, demote or otherwise change an existing membership. The invitation is
        // retired so it cannot be used later (e.g. after this person is removed).
        await tx.workspaceInvitation.update({
          where: { id: current.id },
          data: { status: 'revoked' },
        });
        return { kind: 'already_member' as const, membership: existing, invitedRole: current.role };
      }
      if (existing && existing.updatedAt.getTime() >= current.createdAt.getTime()) {
        // The membership was ended after this invitation was issued (e.g. an invitation from
        // before this release, before removals revoked invitations). It cannot undo that.
        await tx.workspaceInvitation.update({
          where: { id: current.id },
          data: { status: 'revoked' },
        });
        return { kind: 'stale' as const };
      }

      await this.assertSeatAvailable(tx, current.workspaceId, seats, { reservePending: false });
      const role = current.role === 'admin' ? 'admin' : 'member'; // never owner
      const membership = existing
        ? await tx.workspaceMembership.update({
            where: { id: existing.id },
            data: { role, status: 'active', joinedAt: new Date() },
            include: MEMBER_WITH_USER,
          })
        : await tx.workspaceMembership.create({
            data: {
              workspaceId: current.workspaceId,
              userId,
              role,
              status: 'active',
              joinedAt: new Date(),
            },
            include: MEMBER_WITH_USER,
          });
      await tx.workspaceInvitation.update({
        where: { id: current.id },
        data: { status: 'accepted', acceptedByUserId: userId },
      });
      await tx.user.update({
        where: { id: userId },
        data: { lastWorkspaceId: current.workspaceId },
      });
      return { kind: existing ? ('rejoined' as const) : ('joined' as const), membership };
    });

    const audit = {
      actorUserId: userId,
      workspaceId: invitation.workspaceId,
      action: 'accept_invitation',
      targetId: invitation.id,
    };
    if (outcome.kind === 'stale' || outcome.kind === 'inviter_unauthorized') {
      recordWorkspaceAudit(this.audit, this.logger, {
        ...audit,
        type: 'workspace.membership.denied',
        outcome: 'blocked',
        detail:
          outcome.kind === 'stale'
            ? 'result=invitation_predates_membership_change'
            : 'result=inviter_no_longer_authorized',
      });
      throw workspaceException('WORKSPACE_INVITATION_INVALID', 'Invitation is invalid.');
    }
    if (outcome.kind === 'already_member') {
      const roleKept = outcome.membership.role;
      recordWorkspaceAudit(this.audit, this.logger, {
        ...audit,
        type:
          roleKept === outcome.invitedRole
            ? 'workspace.invitation.accepted'
            : 'workspace.membership.denied',
        outcome: roleKept === outcome.invitedRole ? 'success' : 'blocked',
        detail: `result=already_member role_kept=${roleKept} invited_role=${outcome.invitedRole}`,
      });
      return { ...mapMembership(outcome.membership), alreadyMember: true };
    }
    if (outcome.kind === 'joined' || outcome.kind === 'rejoined') {
      recordWorkspaceAudit(this.audit, this.logger, {
        ...audit,
        type: 'workspace.invitation.accepted',
        outcome: 'success',
        detail: `result=${outcome.kind} role=${outcome.membership.role}`,
      });
      return { ...mapMembership(outcome.membership), alreadyMember: false };
    }
    return { ...mapMembership(outcome.membership), alreadyMember: true };
  }

  private async seatLimit(workspaceId: string): Promise<SeatLimit> {
    const entitlements = await this.entitlements.getEntitlements(workspaceId);
    const plan = getProductPlan((await this.entitlements.getPlanId(workspaceId)) ?? 'free');
    return {
      limit: effectiveMaxWorkspaceMembers(entitlements.maxWorkspaceMembers),
      planName: plan.name,
    };
  }

  /**
   * Counted inside the locked transaction, so concurrent invitations/acceptances cannot exceed
   * the limit. Creating reserves a seat per pending invitation; accepting consumes the seat the
   * invitation reserved, so only active members count there.
   */
  private async assertSeatAvailable(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    seats: SeatLimit,
    options: { reservePending: boolean },
  ): Promise<void> {
    const { limit } = seats;
    const used = await tx.workspaceMembership.count({
      where: { workspaceId, status: 'active' },
    });
    if (used >= limit) {
      throw workspaceException(
        'WORKSPACE_MEMBER_LIMIT_REACHED',
        `Workspace member limit reached for the ${seats.planName} plan.`,
        { used, limit },
      );
    }
    if (!options.reservePending) return;
    const pending = await tx.workspaceInvitation.count({
      where: { workspaceId, status: 'pending', expiresAt: { gt: new Date() } },
    });
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
