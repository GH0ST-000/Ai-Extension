import { Injectable } from '@nestjs/common';
import {
  getProductPlan,
  isValidWorkspaceSlug,
  normalizeWorkspaceSlug,
  permissionsForRole,
} from '@project-x/shared';
import type {
  CurrentWorkspaceContext,
  SubscriptionStatus,
  Workspace,
  WorkspaceBootstrapResponse,
  WorkspaceRole,
  WorkspaceStatus,
} from '@project-x/types';
import type { Prisma } from '@prisma/client';

import { EntitlementService } from '../entitlements/entitlements.service';
import { PrismaService } from '../prisma/prisma.service';
import { UsageService } from '../usage/usage.service';
import { WorkspaceAuthorizationService } from './workspace-authorization.service';
import { workspaceException } from './workspace.errors';
import type {
  CreateWorkspaceDto,
  TransferWorkspaceOwnershipDto,
  UpdateWorkspaceDto,
} from './dto/workspaces.dto';

@Injectable()
export class WorkspacesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: WorkspaceAuthorizationService,
    private readonly entitlements: EntitlementService,
    private readonly usage: UsageService,
  ) {}

  async bootstrap(
    userId: string,
    preferredWorkspaceId?: string,
  ): Promise<WorkspaceBootstrapResponse> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, lastWorkspaceId: true },
    });
    if (!user) {
      throw workspaceException('WORKSPACE_ACCESS_DENIED', 'User not found.');
    }

    const memberships = await this.prisma.workspaceMembership.findMany({
      where: { userId, status: 'active', workspace: { status: 'active' } },
      include: {
        workspace: { select: { id: true, name: true, slug: true, status: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    if (memberships.length === 0) {
      throw workspaceException('WORKSPACE_NOT_FOUND', 'No active workspaces for user.');
    }

    const preferred =
      (preferredWorkspaceId &&
        memberships.find((m) => m.workspaceId === preferredWorkspaceId)?.workspaceId) ||
      (user.lastWorkspaceId &&
        memberships.find((m) => m.workspaceId === user.lastWorkspaceId)?.workspaceId) ||
      memberships[0]!.workspaceId;

    if (user.lastWorkspaceId !== preferred) {
      await this.prisma.user.update({
        where: { id: userId },
        data: { lastWorkspaceId: preferred },
      });
    }

    const currentMembership = memberships.find((m) => m.workspaceId === preferred)!;
    const current = await this.buildCurrentContext(
      currentMembership.workspace,
      currentMembership.role as WorkspaceRole,
    );

    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
      workspaces: memberships.map((m) => ({
        id: m.workspace.id,
        name: m.workspace.name,
        slug: m.workspace.slug,
        role: m.role as WorkspaceRole,
      })),
      current,
    };
  }

  async listForUser(userId: string): Promise<Workspace[]> {
    const rows = await this.prisma.workspaceMembership.findMany({
      where: { userId, status: 'active', workspace: { status: { not: 'deleted' } } },
      include: { workspace: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => mapWorkspace(r.workspace));
  }

  async get(workspaceId: string, userId: string): Promise<Workspace> {
    await this.authorization.assertAccess({
      userId,
      workspaceId,
      permission: 'workspace:read',
    });
    const workspace = await this.prisma.workspace.findUnique({ where: { id: workspaceId } });
    if (!workspace || workspace.status === 'deleted') {
      throw workspaceException('WORKSPACE_NOT_FOUND', 'Workspace not found.');
    }
    return mapWorkspace(workspace);
  }

  async create(userId: string, input: CreateWorkspaceDto): Promise<Workspace> {
    const name = input.name.trim();
    const slug = await this.allocateSlug(
      input.slug ? normalizeWorkspaceSlug(input.slug) : normalizeWorkspaceSlug(name),
    );

    const created = await this.prisma.$transaction(async (tx) => {
      const workspace = await tx.workspace.create({
        data: {
          name,
          slug,
          status: 'active',
          createdByUserId: userId,
          memberships: {
            create: {
              userId,
              role: 'owner',
              status: 'active',
              joinedAt: new Date(),
            },
          },
          subscription: {
            create: {
              provider: 'paddle',
              planId: 'free',
              status: 'active',
            },
          },
        },
      });

      await tx.user.update({
        where: { id: userId },
        data: { lastWorkspaceId: workspace.id },
      });

      return workspace;
    });

    this.entitlements.invalidate(created.id);
    return mapWorkspace(created);
  }

  async update(workspaceId: string, userId: string, input: UpdateWorkspaceDto): Promise<Workspace> {
    await this.authorization.assertAccess({
      userId,
      workspaceId,
      permission: 'workspace:update',
    });

    const data: Prisma.WorkspaceUpdateInput = {};
    if (input.name !== undefined) {
      data.name = input.name.trim();
    }
    if (input.slug !== undefined) {
      const slug = normalizeWorkspaceSlug(input.slug);
      if (!isValidWorkspaceSlug(slug)) {
        throw workspaceException('WORKSPACE_INVITATION_INVALID', 'Invalid workspace slug.');
      }
      const clash = await this.prisma.workspace.findFirst({
        where: { slug, id: { not: workspaceId } },
        select: { id: true },
      });
      if (clash) {
        throw workspaceException('WORKSPACE_LIMIT_REACHED', 'Workspace slug is already taken.');
      }
      data.slug = slug;
    }

    const updated = await this.prisma.workspace.update({
      where: { id: workspaceId },
      data,
    });
    return mapWorkspace(updated);
  }

  async softDelete(workspaceId: string, userId: string): Promise<void> {
    await this.authorization.assertAccess({
      userId,
      workspaceId,
      permission: 'workspace:delete',
    });

    await this.prisma.workspace.update({
      where: { id: workspaceId },
      data: { status: 'deleted' },
    });
    this.entitlements.invalidate(workspaceId);
  }

  async transferOwnership(
    workspaceId: string,
    actorUserId: string,
    input: TransferWorkspaceOwnershipDto,
  ): Promise<void> {
    await this.authorization.assertAccess({
      userId: actorUserId,
      workspaceId,
      permission: 'workspace:delete',
    });

    const actorMembership = await this.prisma.workspaceMembership.findFirst({
      where: { workspaceId, userId: actorUserId, status: 'active', role: 'owner' },
    });
    if (!actorMembership) {
      throw workspaceException('WORKSPACE_OWNER_REQUIRED', 'Only an owner can transfer ownership.');
    }

    const target = await this.prisma.workspaceMembership.findFirst({
      where: { id: input.membershipId, workspaceId, status: 'active' },
    });
    if (!target) {
      throw workspaceException('WORKSPACE_MEMBER_NOT_FOUND', 'Target membership not found.');
    }
    if (target.id === actorMembership.id) {
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.workspaceMembership.update({
        where: { id: target.id },
        data: { role: 'owner' },
      });
      await tx.workspaceMembership.update({
        where: { id: actorMembership.id },
        data: { role: 'admin' },
      });
    });
  }

  private async buildCurrentContext(
    workspace: { id: string; name: string; slug: string; status: string },
    role: WorkspaceRole,
  ): Promise<CurrentWorkspaceContext> {
    const entitlements = await this.entitlements.getEntitlements(workspace.id);
    const planId = (await this.entitlements.getPlanId(workspace.id)) ?? 'free';
    const subscription = await this.prisma.workspaceSubscription.findUnique({
      where: { workspaceId: workspace.id },
      select: { status: true },
    });
    const plan = getProductPlan(planId);
    const usage = await this.usage.getUsageCounters(workspace.id);

    return {
      workspace: {
        id: workspace.id,
        name: workspace.name,
        slug: workspace.slug,
        status: workspace.status as WorkspaceStatus,
      },
      membership: {
        role,
        permissions: permissionsForRole(role),
      },
      plan: {
        id: plan.id,
        name: plan.name,
        status: (subscription?.status as SubscriptionStatus) ?? 'none',
      },
      entitlements,
      usage,
      compliance: { compliant: true, violations: [] },
    };
  }

  private async allocateSlug(desired: string, tx?: Prisma.TransactionClient): Promise<string> {
    const client = tx ?? this.prisma;
    let base = normalizeWorkspaceSlug(desired);
    if (!isValidWorkspaceSlug(base)) {
      base = `ws-${randomSuffix()}`;
    }

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const candidate = attempt === 0 ? base : `${base.slice(0, 40)}-${randomSuffix()}`;
      const existing = await client.workspace.findUnique({
        where: { slug: candidate },
        select: { id: true },
      });
      if (!existing) {
        return candidate;
      }
    }

    throw workspaceException('UNKNOWN', 'Unable to allocate a unique workspace slug.');
  }
}

function mapWorkspace(row: {
  id: string;
  name: string;
  slug: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}): Workspace {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status as WorkspaceStatus,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}
