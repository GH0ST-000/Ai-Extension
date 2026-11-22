import { Injectable, Logger, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { WorkspaceStatus } from '@project-x/types';

import {
  BillingService,
  cancellationFailed,
  type DeletionCancellation,
} from '../billing/billing.service';
import { EntitlementService, effectivePlanId } from '../entitlements/entitlements.service';
import { INSTALLATION_TOKEN_CACHE_PREFIX } from '../github-app/github-app-token.service';
import { SecurityAuditService } from '../observability/security-audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { WorkspaceAuthorizationService } from './workspace-authorization.service';
import { workspaceException } from './workspace.errors';
import {
  FREE_WORKSPACE_LIMIT,
  countFreeWorkspaceSlots,
  lockAccountWorkspaces,
} from './workspace-limits';

/** Statuses from which an owner may (re)run deletion; `deleted` makes the call idempotent. */
export const DELETION_ALLOWED_STATUSES: readonly WorkspaceStatus[] = [
  'active',
  'deletion_pending',
  'deleted',
];

export type WorkspaceDeletionResult = {
  status: 'deleted';
  alreadyDeleted: boolean;
  billing: DeletionCancellation;
  githubAppUnlinked: boolean;
};

/** A workspace pending deletion, as shown to its owners (N-2). */
export type PendingWorkspaceDeletion = {
  workspaceId: string;
  name: string;
  /** Cancellations the billing provider has not yet confirmed. */
  openCancellations: number;
  lastErrorCode: string | null;
  nextAttemptAt: string | null;
};

/**
 * Workspace deletion (soft delete; data retained):
 *
 *   active ──▶ deletion_pending ──▶ deleted
 *
 * 1. Start (one short transaction under the per-workspace deletion lock AND the workspace
 *    row lock that every membership change takes): the actor's ownership is re-validated
 *    under the lock (N-13: a concurrent demotion/removal is seen), the workspace becomes
 *    `deletion_pending`, and every subscription that must be cancelled is recorded durably
 *    (BillingCancellationRequest). From that commit on every workspace check refuses it.
 * 2. Billing (OUTSIDE any transaction, N-11): the cancellation requests are processed with a
 *    bounded provider timeout. A failure is kept, retried with backoff by the reconciler and
 *    surfaced — never forgotten (N-2/N-3).
 * 3. Finalization (short transaction, same locks): only when no cancellation is open — the
 *    GitHub App installation is unlinked (re-checked under the row lock, so a concurrent
 *    re-link cannot survive) and the workspace is marked `deleted`.
 *
 * Retry (the owner, or the reconciler) is idempotent: it resumes from whatever is done.
 * Owners can list their pending deletions and retry them (listPendingDeletions).
 *
 * GitHub: only the local association is removed and the cached installation token revoked.
 * The installation is never uninstalled on GitHub; it belongs to exactly one workspace.
 */
@Injectable()
export class WorkspaceDeletionService {
  private readonly logger = new Logger(WorkspaceDeletionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly authorization: WorkspaceAuthorizationService,
    private readonly billing: BillingService,
    private readonly entitlements: EntitlementService,
    @Optional() private readonly redis?: RedisService,
    @Optional() private readonly audit?: SecurityAuditService,
  ) {}

  async deleteWorkspace(workspaceId: string, userId: string): Promise<WorkspaceDeletionResult> {
    // Fast refusal; re-validated under the locks below.
    await this.authorization.assertAccess({
      userId,
      workspaceId,
      permission: 'workspace:delete',
      allowedStatuses: DELETION_ALLOWED_STATUSES,
    });

    const before = await this.prisma.$transaction(async (tx) => {
      await lockWorkspaceDeletion(tx, workspaceId);
      // N-13: ownership re-checked under the workspace row lock (the membership lock).
      await this.authorization.assertAccess({
        userId,
        workspaceId,
        permission: 'workspace:delete',
        allowedStatuses: DELETION_ALLOWED_STATUSES,
        tx,
      });
      const row = await tx.workspace.findUnique({
        where: { id: workspaceId },
        select: { status: true },
      });
      if (!row) throw workspaceException('WORKSPACE_NOT_FOUND', 'Workspace not found.');
      if (row.status === 'deleted') return 'deleted' as const;
      if (row.status === 'active') {
        // F-25: never let an owner strand their own account. A deleted free workspace keeps
        // its slot until the usage period ends (the quota-cycling safeguard, unchanged), so
        // deleting the ONLY workspace of an account whose free slots are all used would leave
        // it with no workspace and no way to create one until next month. That one deletion
        // is refused with an explanation; the anti-abuse accounting is not relaxed.
        await lockAccountWorkspaces(tx, userId);
        const otherActive = await tx.workspaceMembership.count({
          where: {
            userId,
            status: 'active',
            workspaceId: { not: workspaceId },
            workspace: { status: 'active' },
          },
        });
        if (otherActive === 0) {
          // Slots AFTER this deletion: the workspace stops counting as owned; it keeps a slot
          // only if it is free AND this user created it (see countFreeWorkspaceSlots).
          const subscriptionNow = await tx.workspaceSubscription.findUnique({
            where: { workspaceId },
            select: { planId: true, status: true },
          });
          const target = await tx.workspace.findUnique({
            where: { id: workspaceId },
            select: { createdByUserId: true },
          });
          const isFree = effectivePlanId(subscriptionNow) === 'free';
          const usedNow = await countFreeWorkspaceSlots(tx, userId);
          const used =
            usedNow - (isFree ? 1 : 0) + (isFree && target?.createdByUserId === userId ? 1 : 0);
          if (used >= FREE_WORKSPACE_LIMIT) {
            throw workspaceException(
              'WORKSPACE_LIMIT_REACHED',
              `This is your only workspace, and your free workspace slots for this month are used (a workspace deleted this month keeps its slot until the month ends). Deleting it now would leave your account without any workspace. Keep it, or delete it next month.${
                isFree ? '' : ' To stop billing now, cancel the subscription in Billing.'
              }`,
              { reason: 'last_workspace', used, limit: FREE_WORKSPACE_LIMIT },
            );
          }
        }
        // Decision B: remember the plan at deletion start (billing changes it afterwards).
        const subscription = await tx.workspaceSubscription.findUnique({
          where: { workspaceId },
          select: { planId: true, status: true },
        });
        await tx.workspace.update({
          where: { id: workspaceId },
          data: {
            status: 'deletion_pending',
            deletedOnFreePlan: effectivePlanId(subscription) === 'free',
          },
        });
      }
      const local = await this.billing.recordDeletionCancellation(tx, workspaceId);
      return { started: row.status === 'active', local };
    });
    this.entitlements.invalidate(workspaceId);

    if (before === 'deleted') {
      return { status: 'deleted', alreadyDeleted: true, billing: 'none', githubAppUnlinked: false };
    }
    if (before.started) {
      this.recordAudit('workspace.deletion.started', 'success', workspaceId, userId);
    }
    return this.complete(workspaceId, userId, before.local);
  }

  /**
   * Steps 2 and 3. Throws BILLING_CANCELLATION_FAILED (502) while a cancellation is open; the
   * workspace stays pending (unusable) and the reconciler keeps retrying.
   */
  private async complete(
    workspaceId: string,
    actorUserId: string | null,
    local: 'none' | 'requested' | 'cancelled_locally' = 'none',
  ): Promise<WorkspaceDeletionResult> {
    const processed = await this.billing.processCancellationRequests({ workspaceId });
    // A concurrent request may be mid-call to the provider for this workspace: observe it.
    await this.billing.waitForInFlightCancellations(workspaceId);

    const completed = await this.prisma.$transaction(async (tx) => {
      await lockWorkspaceDeletion(tx, workspaceId);
      const rows = await tx.$queryRaw<Array<{ status: string }>>`
        SELECT status FROM workspaces WHERE id = ${workspaceId} FOR UPDATE`;
      const status = rows[0]?.status;
      if (status === 'deleted') return 'already' as const;
      if (status !== 'deletion_pending') {
        throw workspaceException('WORKSPACE_INACTIVE', 'Workspace is not active.');
      }
      if ((await this.billing.openCancellationCount(tx, workspaceId)) > 0) return null;
      const installation = await tx.gitHubAppInstallation.findUnique({
        where: { workspaceId },
        select: { installationId: true },
      });
      if (installation) {
        await tx.gitHubAppInstallation.delete({ where: { workspaceId } });
      }
      await tx.workspace.update({ where: { id: workspaceId }, data: { status: 'deleted' } });
      return { installationId: installation?.installationId ?? null };
    });
    this.entitlements.invalidate(workspaceId);

    if (completed === 'already') {
      return { status: 'deleted', alreadyDeleted: true, billing: 'none', githubAppUnlinked: false };
    }
    if (completed === null) {
      throw cancellationFailed();
    }
    if (completed.installationId) {
      await this.revokeInstallationToken(completed.installationId);
    }
    const billing: DeletionCancellation =
      processed.outcomes[0] ?? (local === 'cancelled_locally' ? 'cancelled_locally' : 'none');
    this.logger.log({
      msg: 'workspace.deleted',
      workspaceId,
      billing,
      githubAppUnlinked: completed.installationId !== null,
    });
    this.recordAudit('workspace.deletion.completed', 'success', workspaceId, actorUserId);
    return {
      status: 'deleted',
      alreadyDeleted: false,
      billing,
      githubAppUnlinked: completed.installationId !== null,
    };
  }

  /** Workspaces pending deletion that `userId` owns, with their billing state (N-2). */
  async listPendingDeletions(userId: string): Promise<PendingWorkspaceDeletion[]> {
    const memberships = await this.prisma.workspaceMembership.findMany({
      where: {
        userId,
        status: 'active',
        role: 'owner',
        workspace: { status: 'deletion_pending' },
      },
      select: { workspace: { select: { id: true, name: true } } },
      take: 50,
    });
    const out: PendingWorkspaceDeletion[] = [];
    for (const { workspace } of memberships) {
      const open = await this.prisma.billingCancellationRequest.findMany({
        where: { workspaceId: workspace.id, status: { in: ['pending', 'processing'] } },
        orderBy: { nextAttemptAt: 'asc' },
        select: { lastErrorCode: true, nextAttemptAt: true },
      });
      out.push({
        workspaceId: workspace.id,
        name: workspace.name,
        openCancellations: open.length,
        lastErrorCode: open[0]?.lastErrorCode ?? null,
        nextAttemptAt: open[0]?.nextAttemptAt.toISOString() ?? null,
      });
    }
    return out;
  }

  /**
   * Reconciler pass (no user): retry due cancellations, then finalize pending deletions whose
   * cancellations are all confirmed. Idempotent; safe to run concurrently with requests.
   */
  async reconcile(): Promise<{ finalized: number }> {
    await this.billing.processCancellationRequests({ limit: 50 });
    // Fair paging (adversarial N5): only workspaces with nothing left to cancel, oldest first.
    const pending = await this.prisma.workspace.findMany({
      where: {
        status: 'deletion_pending',
        billingCancellationRequests: { none: { status: { in: ['pending', 'processing'] } } },
      },
      orderBy: { updatedAt: 'asc' },
      select: { id: true },
      take: 50,
    });
    let finalized = 0;
    for (const { id } of pending) {
      if ((await this.billing.openCancellationCount(this.prisma, id)) > 0) continue;
      try {
        const result = await this.complete(id, null);
        if (!result.alreadyDeleted) finalized += 1;
      } catch (error) {
        this.logger.warn({
          msg: 'workspace.deletion.reconcile_failed',
          workspaceId: id,
          errorName: error instanceof Error ? error.name : 'unknown',
        });
      }
    }
    return { finalized };
  }

  private recordAudit(
    type: 'workspace.deletion.started' | 'workspace.deletion.completed',
    outcome: 'success',
    workspaceId: string,
    actorUserId: string | null,
  ): void {
    try {
      this.audit?.record({
        type,
        outcome,
        workspaceId,
        ...(actorUserId ? { actorUserId } : {}),
        detail: actorUserId ? 'actor=owner' : 'actor=reconciler',
      });
    } catch {
      // never break deletion on audit
    }
  }

  private async revokeInstallationToken(installationId: string): Promise<void> {
    try {
      if (this.redis?.status === 'wait') await this.redis.connect();
      await this.redis?.del(`${INSTALLATION_TOKEN_CACHE_PREFIX}${installationId}`);
    } catch (error) {
      this.logger.warn({
        msg: 'workspace.deleted.token_cache_revoke_failed',
        errorName: error instanceof Error ? error.name : 'unknown',
      });
    }
  }
}

/** Serializes deletion of one workspace across requests and processes (released at commit). */
async function lockWorkspaceDeletion(
  tx: Prisma.TransactionClient,
  workspaceId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('workspace-deletion'), hashtext(${workspaceId}))`;
}
