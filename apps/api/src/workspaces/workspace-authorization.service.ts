import { Injectable } from '@nestjs/common';
import { permissionsForRole, roleHasPermission } from '@project-x/shared';
import type { WorkspacePermission, WorkspaceRole, WorkspaceStatus } from '@project-x/types';

import { PrismaService } from '../prisma/prisma.service';
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
  }): Promise<WorkspaceRequestContext> {
    const workspace = await this.prisma.workspace.findUnique({
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

    if (workspace.status !== ACTIVE_WORKSPACE) {
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

  async countActiveOwners(workspaceId: string): Promise<number> {
    return this.prisma.workspaceMembership.count({
      where: {
        workspaceId,
        status: ACTIVE_MEMBERSHIP,
        role: 'owner',
      },
    });
  }

  async assertNotSoleOwner(workspaceId: string, membershipId: string): Promise<void> {
    const membership = await this.prisma.workspaceMembership.findFirst({
      where: { id: membershipId, workspaceId, status: ACTIVE_MEMBERSHIP },
      select: { id: true, role: true },
    });

    if (!membership) {
      throw workspaceException('WORKSPACE_MEMBER_NOT_FOUND', 'Membership not found.');
    }

    if (membership.role !== 'owner') {
      return;
    }

    const owners = await this.countActiveOwners(workspaceId);
    if (owners <= 1) {
      throw workspaceException(
        'WORKSPACE_LAST_OWNER',
        'The sole owner cannot leave or be demoted. Transfer ownership first.',
      );
    }
  }
}
