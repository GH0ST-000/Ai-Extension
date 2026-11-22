import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { permissionsForRole, roleHasPermission } from '@project-x/shared';
import type { WorkspacePermission, WorkspaceRole, WorkspaceStatus } from '@project-x/types';

import { PrismaService } from '../prisma/prisma.service';
import { lockWorkspaceMembership } from './workspace-membership-lock';
import { workspaceException } from './workspace.errors';
import type { WorkspaceRequestContext } from './workspace.decorators';

const ACTIVE_MEMBERSHIP = 'active';
const ACTIVE_WORKSPACE: WorkspaceStatus = 'active';

@Injectable()
export class WorkspaceAuthorizationService {
  constructor(private readonly prisma: PrismaService) {}

  async assertAccess(input: {
    userId: string;
    workspaceId: string;
    permission?: WorkspacePermission;
    /**
     * Workspace statuses accepted besides `active`. Only workspace deletion uses this (to
     * retry or confirm a deletion); every other operation requires an active workspace.
     */
    allowedStatuses?: readonly WorkspaceStatus[];
    /**
     * M3: inside a membership-changing transaction. Takes the workspace membership lock first
     * and re-validates the actor under it, so a concurrent demotion/removal of the actor (or
     * the start of a deletion) is seen before anything is changed.
     */
    tx?: Prisma.TransactionClient;
  }): Promise<WorkspaceRequestContext> {
    const client = input.tx ?? this.prisma;
    if (input.tx) {
      await lockWorkspaceMembership(input.tx, input.workspaceId);
    }
    const workspace = await client.workspace.findUnique({
      where: { id: input.workspaceId },
      select: {
        id: true,
        status: true,
        memberships: {
          where: { userId: input.userId, status: ACTIVE_MEMBERSHIP },
          select: { id: true, role: true, status: true },
          take: 1,
        },
      },
    });

    if (!workspace) {
      throw workspaceException('WORKSPACE_NOT_FOUND', 'Workspace not found.');
    }

    const allowed = input.allowedStatuses ?? [ACTIVE_WORKSPACE];
    if (!allowed.includes(workspace.status as WorkspaceStatus)) {
      throw workspaceException('WORKSPACE_INACTIVE', 'Workspace is not active.');
    }

    const membership = workspace.memberships[0];
    if (!membership) {
      throw workspaceException(
        'WORKSPACE_ACCESS_DENIED',
        'You are not a member of this workspace.',
      );
    }

    const role = membership.role as WorkspaceRole;
    if (input.permission && !roleHasPermission(role, input.permission)) {
      throw workspaceException(
        'WORKSPACE_ACCESS_DENIED',
        'You do not have permission to perform this action.',
        { permission: input.permission, role },
      );
    }

    return {
      workspaceId: workspace.id,
      membershipId: membership.id,
      role,
      permissions: permissionsForRole(role),
    };
  }

  async countActiveOwners(
    workspaceId: string,
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<number> {
    return client.workspaceMembership.count({
      where: {
        workspaceId,
        status: ACTIVE_MEMBERSHIP,
        role: 'owner',
      },
    });
  }

  /**
   * Refuses to remove or demote the last active owner. M3: called with the transaction that
   * holds the workspace membership lock, so the count is exact even under concurrent owner
   * removals/demotions (each waits for the previous one and counts what it committed).
   */
  async assertNotSoleOwner(
    workspaceId: string,
    membershipId: string,
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    const membership = await client.workspaceMembership.findFirst({
      where: { id: membershipId, workspaceId, status: ACTIVE_MEMBERSHIP },
      select: { id: true, role: true },
    });

    if (!membership) {
      throw workspaceException('WORKSPACE_MEMBER_NOT_FOUND', 'Membership not found.');
    }

    if (membership.role !== 'owner') {
      return;
    }

    const owners = await this.countActiveOwners(workspaceId, client);
    if (owners <= 1) {
      throw workspaceException(
        'WORKSPACE_LAST_OWNER',
        'The sole owner cannot leave or be demoted. Transfer ownership first.',
      );
    }
  }
}
