import { Injectable, Logger, Optional } from '@nestjs/common';
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
import { Prisma } from '@prisma/client';

import { EntitlementService, effectivePlanId } from '../entitlements/entitlements.service';
import { PrismaService } from '../prisma/prisma.service';
import { UsageService } from '../usage/usage.service';
import { SecurityAuditService } from '../observability/security-audit.service';
import { WorkspaceAuthorizationService } from './workspace-authorization.service';
import { recordWorkspaceAudit, recordWorkspaceDenial } from './workspace-audit';
import { revokePendingInvitationsFor } from './workspace-membership-lock';
import {
  assertFreeWorkspaceSlot,
  freeWorkspaceUsage,
  type FreeWorkspaceUsage,
  lockAccountWorkspaces,
} from './workspace-limits';
import { workspaceException } from './workspace.errors';
import type {
  CreateWorkspaceDto,
  TransferWorkspaceOwnershipDto,
  UpdateWorkspaceDto,
} from './dto/workspaces.dto';

@Injectable()
export class WorkspacesService {
  private readonly logger = new Logger(WorkspacesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: WorkspaceAuthorizationService,
    private readonly entitlements: EntitlementService,
    private readonly usage: UsageService,
    @Optional() private readonly audit?: SecurityAuditService,
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
    const desired = input.slug ? normalizeWorkspaceSlug(input.slug) : normalizeWorkspaceSlug(name);

    // F-25: "is the slug free?" cannot see another transaction's uncommitted insert, so two
    // concurrent creations of one name both pass it and the second hits the unique index. That
    // is not an error: the whole transaction is retried with a freshly allocated (suffixed)
    // slug instead of surfacing a raw database error as HTTP 500.
    let created: Awaited<ReturnType<typeof this.createWithSlug>> | undefined;
    for (let attempt = 0; attempt < WORKSPACE_SLUG_ATTEMPTS && !created; attempt += 1) {
      const slug = await this.allocateSlug(
        attempt === 0 ? desired : `${desired.slice(0, 40)}-${randomSuffix()}`,
      );
      try {
        created = await this.createWithSlug(userId, name, slug);
      } catch (error) {
        if (isSlugConflict(error) && attempt + 1 < WORKSPACE_SLUG_ATTEMPTS) continue;
        if (isSlugConflict(error)) {
          throw workspaceException('UNKNOWN', 'Unable to allocate a unique workspace slug.');
        }
        throw error;
      }
    }
    if (!created) throw workspaceException('UNKNOWN', 'Unable to create the workspace.');

    this.entitlements.invalidate(created.id);
    return mapWorkspace(created);
  }

  private createWithSlug(userId: string, name: string, slug: string) {
    return this.prisma.$transaction(async (tx) => {
      // Decision B: a new workspace starts on the free plan — counted and decided under the
      // account lock, so concurrent creations cannot exceed the free limit.
      await lockAccountWorkspaces(tx, userId);
      await assertFreeWorkspaceSlot(tx, userId, 'create');
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
  }

  /** Decision B: the caller's free-workspace usage (for the dashboard). */
  async freeWorkspaceUsage(userId: string): Promise<FreeWorkspaceUsage> {
    return freeWorkspaceUsage(this.prisma, userId);
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

    let updated;
    try {
      updated = await this.prisma.workspace.update({
        where: { id: workspaceId },
        data,
      });
    } catch (error) {
      // F-25: another workspace took the slug between the check above and this write.
      if (isSlugConflict(error)) {
        throw workspaceException('WORKSPACE_LIMIT_REACHED', 'Workspace slug is already taken.');
      }
      throw error;
    }
    return mapWorkspace(updated);
  }

  /**
   * Explicit ownership transfer (unchanged semantics: the target becomes owner, the acting
   * owner becomes admin). M3: one transaction under the workspace membership lock, actor and
   * target re-validated there, and both people's pending invitations revoked with the change.
   */
  async transferOwnership(
    workspaceId: string,
    actorUserId: string,
    input: TransferWorkspaceOwnershipDto,
  ): Promise<void> {
    const auditTarget = {
      actorUserId,
      workspaceId,
      action: 'transfer_ownership',
      targetId: input.membershipId,
    };
    try {
      await this.authorization.assertAccess({
        userId: actorUserId,
        workspaceId,
        permission: 'workspace:delete',
      });

      const transferred = await this.prisma.$transaction(async (tx) => {
        await this.authorization.assertAccess({
          userId: actorUserId,
          workspaceId,
          permission: 'workspace:delete',
          tx,
        });
        const actorMembership = await tx.workspaceMembership.findFirst({
          where: { workspaceId, userId: actorUserId, status: 'active', role: 'owner' },
          include: { user: { select: { email: true } } },
        });
        if (!actorMembership) {
          throw workspaceException(
            'WORKSPACE_OWNER_REQUIRED',
            'Only an owner can transfer ownership.',
          );
        }
        const target = await tx.workspaceMembership.findFirst({
          where: { id: input.membershipId, workspaceId, status: 'active' },
          include: { user: { select: { email: true } } },
        });
        if (!target) {
          throw workspaceException('WORKSPACE_MEMBER_NOT_FOUND', 'Target membership not found.');
        }
        if (target.id === actorMembership.id) {
          return false;
        }
        // INFO (final audit): transferring to someone who is already an owner would only demote
        // the actor; two concurrent transfers to the same person would demote both. Refused.
        // Decision B: receiving a FREE workspace uses one of the new owner's free slots
        // (otherwise transfers would bypass the limit). Paid workspaces are never counted.
        const subscription = await tx.workspaceSubscription.findUnique({
          where: { workspaceId },
          select: { planId: true, status: true },
        });
        if (effectivePlanId(subscription) === 'free') {
          await lockAccountWorkspaces(tx, target.userId);
          await assertFreeWorkspaceSlot(tx, target.userId, 'receive');
        }
        if (target.role === 'owner') {
          throw workspaceException(
            'WORKSPACE_ACCESS_DENIED',
            'This member is already an owner. Ownership was not transferred.',
          );
        }
        await tx.workspaceMembership.update({
          where: { id: target.id },
          data: { role: 'owner' },
        });
        await tx.workspaceMembership.update({
          where: { id: actorMembership.id },
          data: { role: 'admin' },
        });
        await revokePendingInvitationsFor(tx, workspaceId, target.user.email);
        await revokePendingInvitationsFor(tx, workspaceId, actorMembership.user.email);
        return true;
      });

      if (transferred) {
        recordWorkspaceAudit(this.audit, this.logger, {
          ...auditTarget,
          type: 'workspace.ownership.transferred',
          outcome: 'success',
        });
      }
    } catch (error) {
      recordWorkspaceDenial(this.audit, this.logger, error, auditTarget);
      throw error;
    }
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

const WORKSPACE_SLUG_ATTEMPTS = 5;

/** A unique violation on `workspaces.slug` (Prisma P2002). */
function isSlugConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const target = error.meta?.target;
  const text = Array.isArray(target) ? target.join(',') : String(target ?? '');
  return text.toLowerCase().includes('slug');
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}
