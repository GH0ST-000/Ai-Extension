import { Injectable } from '@nestjs/common';
import type { WorkspaceMembership } from '@project-x/types';

import { PrismaService } from '../prisma/prisma.service';
import { WorkspaceAuthorizationService } from './workspace-authorization.service';
import { workspaceException } from './workspace.errors';
import type { ChangeWorkspaceMemberRoleDto } from './dto/workspaces.dto';

@Injectable()
export class WorkspaceMembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: WorkspaceAuthorizationService,
  ) {}

  async listMembers(workspaceId: string, userId: string): Promise<WorkspaceMembership[]> {
    await this.authorization.assertAccess({
      userId,
      workspaceId,
      permission: 'members:read',
    });

    const rows = await this.prisma.workspaceMembership.findMany({
      where: { workspaceId, status: 'active' },
      include: { user: { select: { id: true, email: true, name: true } } },
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
    await this.authorization.assertAccess({
      userId: actorUserId,
      workspaceId,
      permission: 'members:manage',
    });

    const membership = await this.prisma.workspaceMembership.findFirst({
      where: { id: membershipId, workspaceId, status: 'active' },
    });
    if (!membership) {
      throw workspaceException('WORKSPACE_MEMBER_NOT_FOUND', 'Membership not found.');
    }

    if (membership.role === 'owner') {
      await this.authorization.assertNotSoleOwner(workspaceId, membershipId);
    }

    const updated = await this.prisma.workspaceMembership.update({
      where: { id: membershipId },
      data: { role: input.role },
      include: { user: { select: { id: true, email: true, name: true } } },
    });

    return mapMembership(updated);
  }

  async removeMember(
    workspaceId: string,
    actorUserId: string,
    membershipId: string,
  ): Promise<void> {
    await this.authorization.assertAccess({
      userId: actorUserId,
      workspaceId,
      permission: 'members:manage',
    });

    const membership = await this.prisma.workspaceMembership.findFirst({
      where: { id: membershipId, workspaceId, status: 'active' },
    });
    if (!membership) {
      throw workspaceException('WORKSPACE_MEMBER_NOT_FOUND', 'Membership not found.');
    }

    // Members may remove themselves without members:manage — handled via same path when actor matches.
    if (membership.userId === actorUserId && membership.role === 'owner') {
      await this.authorization.assertNotSoleOwner(workspaceId, membershipId);
    } else if (membership.role === 'owner') {
      await this.authorization.assertNotSoleOwner(workspaceId, membershipId);
    }

    await this.prisma.workspaceMembership.update({
      where: { id: membershipId },
      data: { status: 'removed' },
    });
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
