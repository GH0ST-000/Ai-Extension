import { Injectable, Logger, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { roleHasPermission } from '@project-x/shared';
import type { WorkspaceMembership, WorkspaceRole } from '@project-x/types';

import { SecurityAuditService } from '../observability/security-audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { WorkspaceAuthorizationService } from './workspace-authorization.service';
import type { WorkspaceRequestContext } from './workspace.decorators';
import { recordWorkspaceAudit, recordWorkspaceDenial } from './workspace-audit';
import {
  revokePendingInvitationsFor,
  revokePendingInvitationsIssuedBy,
} from './workspace-membership-lock';
import { workspaceException } from './workspace.errors';
import type { ChangeWorkspaceMemberRoleDto } from './dto/workspaces.dto';

const MEMBER_WITH_USER = { user: { select: { id: true, email: true, name: true } } } as const;

/**
 * Role changes and removals (M3): each runs in one transaction under the workspace membership
 * lock, re-validates the actor and the target there, protects the last owner with an exact
 * in-transaction count, and retires the target's pending invitations atomically with the
 * change, so no older invitation can undo it.
 */
@Injectable()
export class WorkspaceMembersService {
  private readonly logger = new Logger(WorkspaceMembersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: WorkspaceAuthorizationService,
    @Optional() private readonly audit?: SecurityAuditService,
  ) {}

  async listMembers(workspaceId: string, userId: string): Promise<WorkspaceMembership[]> {
    await this.authorization.assertAccess({
      userId,
      workspaceId,
      permission: 'members:read',
    });

    const rows = await this.prisma.workspaceMembership.findMany({
      where: { workspaceId, status: 'active' },
      include: MEMBER_WITH_USER,
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
    });

    return rows.map(mapMembership);
  }

  async changeRole(
    workspaceId: string,
    actorUserId: string,
    membershipId: string,
    input: ChangeWorkspaceMemberRoleDto,
  ): Promise<WorkspaceMembership> {
    const auditTarget = { actorUserId, workspaceId, action: 'change_role', targetId: membershipId };
    try {
      // Fast refusal before taking the lock (re-checked under it below).
      await this.authorization.assertAccess({
        userId: actorUserId,
        workspaceId,
        permission: 'members:manage',
      });

      // DTO already forbids 'owner'; defense-in-depth.
      if (input.role === ('owner' as WorkspaceRole)) {
        throw workspaceException(
          'WORKSPACE_ACCESS_DENIED',
          'Ownership can only be transferred via the ownership transfer endpoint.',
        );
      }

      const { updated, previousRole, invitationsRevoked } = await this.prisma.$transaction(
        async (tx) => {
          const actor = await this.authorization.assertAccess({
            userId: actorUserId,
            workspaceId,
            permission: 'members:manage',
            tx,
          });
          const membership = await this.findActiveTarget(tx, workspaceId, membershipId);
          this.assertMayManage(actor, actorUserId, membership, 'change');
          if (membership.role === 'owner') {
            await this.authorization.assertNotSoleOwner(workspaceId, membershipId, tx);
          }
          const row = await tx.workspaceMembership.update({
            where: { id: membershipId },
            data: { role: input.role },
            include: MEMBER_WITH_USER,
          });
          let revoked = await revokePendingInvitationsFor(tx, workspaceId, membership.user.email);
          // F-14: a member who can no longer invite leaves no usable invitations behind.
          if (!roleHasPermission(input.role, 'members:invite')) {
            revoked += await revokePendingInvitationsIssuedBy(tx, workspaceId, membership.userId);
          }
          return { updated: row, previousRole: membership.role, invitationsRevoked: revoked };
        },
      );

      recordWorkspaceAudit(this.audit, this.logger, {
        ...auditTarget,
        type: 'workspace.member.role_changed',
        outcome: 'success',
        detail: `from=${previousRole} to=${input.role} invitations_revoked=${invitationsRevoked}`,
      });
      return mapMembership(updated);
    } catch (error) {
      recordWorkspaceDenial(this.audit, this.logger, error, auditTarget);
      throw error;
    }
  }

  async removeMember(
    workspaceId: string,
    actorUserId: string,
    membershipId: string,
  ): Promise<void> {
    const auditTarget = {
      actorUserId,
      workspaceId,
      action: 'remove_member',
      targetId: membershipId,
    };
    try {
      await this.authorization.assertAccess({
        userId: actorUserId,
        workspaceId,
        permission: 'members:manage',
      });

      const { role, invitationsRevoked } = await this.prisma.$transaction(async (tx) => {
        const actor = await this.authorization.assertAccess({
          userId: actorUserId,
          workspaceId,
          permission: 'members:manage',
          tx,
        });
        const membership = await this.findActiveTarget(tx, workspaceId, membershipId);
        this.assertMayManage(actor, actorUserId, membership, 'remove');
        if (membership.role === 'owner') {
          await this.authorization.assertNotSoleOwner(workspaceId, membershipId, tx);
        }
        await tx.workspaceMembership.update({
          where: { id: membershipId },
          data: { status: 'removed' },
        });
        const revoked =
          (await revokePendingInvitationsFor(tx, workspaceId, membership.user.email)) +
          // F-14: nor do the invitations they issued outlive their membership.
          (await revokePendingInvitationsIssuedBy(tx, workspaceId, membership.userId));
        return { role: membership.role, invitationsRevoked: revoked };
      });

      recordWorkspaceAudit(this.audit, this.logger, {
        ...auditTarget,
        type: 'workspace.member.removed',
        outcome: 'success',
        detail: `role=${role} invitations_revoked=${invitationsRevoked}`,
      });
    } catch (error) {
      recordWorkspaceDenial(this.audit, this.logger, error, auditTarget);
      throw error;
    }
  }

  private async findActiveTarget(
    tx: Prisma.TransactionClient,
    workspaceId: string,
    membershipId: string,
  ) {
    const membership = await tx.workspaceMembership.findFirst({
      where: { id: membershipId, workspaceId, status: 'active' },
      include: { user: { select: { email: true } } },
    });
    if (!membership) {
      throw workspaceException('WORKSPACE_MEMBER_NOT_FOUND', 'Membership not found.');
    }
    return membership;
  }

  /** The existing RBAC rules, evaluated on state read under the lock. */
  private assertMayManage(
    actor: WorkspaceRequestContext,
    actorUserId: string,
    membership: { role: string; userId: string },
    operation: 'change' | 'remove',
  ): void {
    // Only an OWNER may change or remove an OWNER.
    if (membership.role === 'owner' && actor.role !== 'owner') {
      throw workspaceException(
        'WORKSPACE_ACCESS_DENIED',
        operation === 'change'
          ? 'Only an owner can change another owner’s role.'
          : 'Only an owner can remove another owner.',
      );
    }
    // ADMIN cannot change their own role.
    if (operation === 'change' && actor.role === 'admin' && membership.userId === actorUserId) {
      throw workspaceException('WORKSPACE_ACCESS_DENIED', 'Admins cannot change their own role.');
    }
  }
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
