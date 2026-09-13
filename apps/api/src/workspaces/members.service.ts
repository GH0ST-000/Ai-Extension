import { Injectable } from '@nestjs/common';
import type { WorkspaceMembership, WorkspaceRole } from '@project-x/types';

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
    const actor = await this.authorization.assertAccess({
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

    const membership = await this.prisma.workspaceMembership.findFirst({
      where: { id: membershipId, workspaceId, status: 'active' },
    });
    if (!membership) {
      throw workspaceException('WORKSPACE_MEMBER_NOT_FOUND', 'Membership not found.');
    }

    // Only OWNER may change roles involving an OWNER (demote) or touch owner seats.
    if (membership.role === 'owner') {
      if (actor.role !== 'owner') {
        throw workspaceException(
          'WORKSPACE_ACCESS_DENIED',
          'Only an owner can change another owner’s role.',
        );
      }
      await this.authorization.assertNotSoleOwner(workspaceId, membershipId);
    }

    // ADMIN cannot promote themselves or others beyond admin (owner already blocked).
    if (actor.role === 'admin' && membership.userId === actorUserId) {
      throw workspaceException('WORKSPACE_ACCESS_DENIED', 'Admins cannot change their own role.');
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
    const actor = await this.authorization.assertAccess({
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
      if (actor.role !== 'owner') {
        throw workspaceException(
          'WORKSPACE_ACCESS_DENIED',
          'Only an owner can remove another owner.',
        );
      }
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
