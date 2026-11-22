import {
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { usagePeriodKey, usagePeriodResetAt } from '@project-x/shared';
import type {
  ProductEntitlements,
  UsageConsumeResult,
  UsageMetric,
  WorkspaceUsageCounter,
} from '@project-x/types';
import { Prisma } from '@prisma/client';

import { EntitlementService } from '../entitlements/entitlements.service';
import { SecurityAuditService } from '../observability/security-audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { workspaceException } from '../workspaces/workspace.errors';

/** Metrics whose units are AI model executions (multi-repo analysis is deterministic). */
const FREE_AI_METRICS: ReadonlySet<UsageMetric> = new Set(['ai_action', 'workflow_run']);

const METRIC_LIMIT_KEY: Record<Exclude<UsageMetric, 'pr_review'>, keyof ProductEntitlements> = {
  ai_action: 'monthlyAiActions',
  workflow_run: 'monthlyWorkflowRuns',
  multi_repo_analysis: 'monthlyMultiRepoAnalyses',
};

@Injectable()
export class UsageService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UsageService.name);
  private sweeper?: ReturnType<typeof setInterval>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementService,
    @Optional() private readonly securityAudit?: SecurityAuditService,
  ) {}

  /**
   * Periodic maintenance in every API instance (idempotent, safe to overlap): recover
   * reservations whose lease expired in workspaces that are otherwise idle, and erase replay
   * copies as soon as they expire instead of waiting for the next request.
   */
  onModuleInit(): void {
    this.sweeper = setInterval(() => {
      void this.sweep().catch((error: unknown) =>
        this.logger.warn({
          msg: 'usage.sweep_failed',
          errorName: error instanceof Error ? error.name : 'unknown',
        }),
      );
    }, SWEEP_INTERVAL_MS);
    this.sweeper.unref?.();
  }

  onModuleDestroy(): void {
    if (this.sweeper) clearInterval(this.sweeper);
  }

  /** One maintenance pass over all workspaces (see {@link onModuleInit}). */
  async sweep(now = new Date()): Promise<{ workspaces: number; resultsCleared: number }> {
    const cleared = await this.prisma.workspaceUsageEvent.updateMany({
      where: { resultExpiresAt: { lt: now } },
      data: { resultText: null, resultMeta: Prisma.DbNull, resultExpiresAt: null },
    });
    const expired = await this.prisma.workspaceUsageEvent.findMany({
      where: { status: 'reserved', leaseExpiresAt: { lt: now } },
      select: { workspaceId: true },
      distinct: ['workspaceId'],
      take: 100,
    });
    for (const { workspaceId } of expired) await this.recoverExpiredReservations(workspaceId, now);
    return { workspaces: expired.length, resultsCleared: cleared.count };
  }

  /**
   * Keep a reservation's lease alive while its operation runs; returns the stop function.
   * Every operation that holds a reservation for longer than a request must use this, or a
   * concurrent recovery could settle it while it is still running.
   */
  startHeartbeat(reservation: UsageReservation): () => void {
    const timer = setInterval(() => {
      Promise.resolve()
        .then(() => this.renewLease(reservation))
        .catch((error: unknown) =>
          this.logger.warn({
            msg: 'usage.lease_renew_failed',
            operationId: reservation.operationId,
            errorName: error instanceof Error ? error.name : 'unknown',
          }),
        );
    }, LEASE_RENEW_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  async getUsageCounters(workspaceId: string): Promise<WorkspaceUsageCounter[]> {
    const period = usagePeriodKey();
    const entitlements = await this.entitlements.getEntitlements(workspaceId);
    const metrics: UsageMetric[] = ['ai_action', 'workflow_run', 'multi_repo_analysis'];

    const rows = await this.prisma.workspaceUsageCounter.findMany({
      where: { workspaceId, periodKey: period, metric: { in: metrics } },
    });
    const byMetric = new Map(rows.map((r) => [r.metric, r.count]));

    return metrics.map((metric) => {
      const limit = limitForMetric(entitlements, metric);
      const count = byMetric.get(metric) ?? 0;
      return {
        workspaceId,
        metric,
        period,
        count,
        limit,
        remaining: limit === null ? null : Math.max(0, limit - count),
      };
    });
  }

  /**
   * Atomically add `quantity` to the period counter if it stays within `limit` (no limit:
   * always). Runs inside `tx`: the counter row is created with ON CONFLICT DO NOTHING and
   * incremented with a single conditional UPDATE, so concurrent charges can never push the
   * count past the limit (PostgreSQL re-checks the predicate on the locked row).
   */
  private async incrementWithinLimit(
    tx: Prisma.TransactionClient,
    input: { workspaceId: string; metric: UsageMetric; periodKey: string; quantity: number },
    limit: number | null,
  ): Promise<{ allowed: boolean; current: number }> {
    const key = {
      workspaceId: input.workspaceId,
      metric: input.metric,
      periodKey: input.periodKey,
    };
    await tx.workspaceUsageCounter.createMany({
      data: [{ ...key, count: 0 }],
      skipDuplicates: true,
    });
    const updated = await tx.workspaceUsageCounter.updateMany({
      where: { ...key, ...(limit !== null ? { count: { lte: limit - input.quantity } } : {}) },
      data: { count: { increment: input.quantity } },
    });
    const row = await tx.workspaceUsageCounter.findUnique({
      where: { workspaceId_metric_periodKey: key },
    });
    return { allowed: updated.count === 1, current: row?.count ?? 0 };
  }

  private async limitContext(workspaceId: string, metric: UsageMetric) {
    const period = usagePeriodKey();
    const entitlements = await this.entitlements.getEntitlements(workspaceId);
    const limit = limitForMetric(entitlements, metric);
    const planId = await this.entitlements.getPlanId(workspaceId);
    return {
      period,
      planId,
      limit,
      resetAt: usagePeriodResetAt(period),
      upgradeAvailable: planId !== 'team',
    };
  }

  private limitReached(
    metric: UsageMetric,
    ctx: { limit: number | null; resetAt: string; upgradeAvailable: boolean },
    used: number,
  ) {
    return workspaceException(
      'USAGE_LIMIT_REACHED',
      `You've used all ${ctx.limit ?? 0} ${metric.replace(/_/g, ' ')}s included in your current plan.`,
      {
        metric,
        limit: ctx.limit,
        used,
        resetAt: ctx.resetAt,
        upgradeAvailable: ctx.upgradeAvailable,
      },
    );
  }

  /**
   * Charge a usage unit immediately (non-AI metered operations, e.g. multi-repo analysis).
   * With an `idempotencyKey`, a repeated key is reported as `duplicate` and charges nothing.
   * AI model executions must use {@link reserve} / {@link commit} instead: a duplicate key is
   * never permission to run an operation.
   */
  async consume(input: {
    workspaceId: string;
    metric: UsageMetric;
    quantity?: number;
    idempotencyKey?: string;
  }): Promise<UsageConsumeResult> {
    if (input.metric === 'pr_review') {
      throw workspaceException('USAGE_LIMIT_REACHED', 'Unsupported usage metric.');
    }
    const quantity = input.quantity ?? 1;
    if (quantity < 1) {
      throw workspaceException('USAGE_LIMIT_REACHED', 'Quantity must be at least 1.');
    }
    const ctx = await this.limitContext(input.workspaceId, input.metric);

    let result: { allowed: boolean; current: number; duplicate: boolean };
    try {
      result = await this.prisma.$transaction(async (tx) => {
        if (input.idempotencyKey) {
          const existing = await tx.workspaceUsageEvent.findUnique({
            where: {
              workspaceId_idempotencyKey: {
                workspaceId: input.workspaceId,
                idempotencyKey: input.idempotencyKey,
              },
            },
          });
          if (existing) {
            const counter = await tx.workspaceUsageCounter.findUnique({
              where: {
                workspaceId_metric_periodKey: {
                  workspaceId: input.workspaceId,
                  metric: input.metric,
                  periodKey: ctx.period,
                },
              },
            });
            return { allowed: true, current: counter?.count ?? 0, duplicate: true };
          }
        }
        const charged = await this.incrementWithinLimit(
          tx,
          { workspaceId: input.workspaceId, metric: input.metric, periodKey: ctx.period, quantity },
          ctx.limit,
        );
        if (!charged.allowed) return { ...charged, duplicate: false };
        if (input.idempotencyKey) {
          // A concurrent duplicate fails here (unique key) and rolls the increment back.
          await tx.workspaceUsageEvent.create({
            data: {
              workspaceId: input.workspaceId,
              metric: input.metric,
              periodKey: ctx.period,
              idempotencyKey: input.idempotencyKey,
              quantity,
            },
          });
        }
        return { ...charged, duplicate: false };
      });
    } catch (error) {
      if (isUniqueViolation(error) && input.idempotencyKey) {
        const counters = await this.getUsageCounters(input.workspaceId);
        const row = counters.find((c) => c.metric === input.metric);
        result = { allowed: true, current: row?.count ?? 0, duplicate: true };
      } else {
        throw error;
      }
    }

    if (!result.allowed) throw this.limitReached(input.metric, ctx, result.current);
    return {
      allowed: true,
      metric: input.metric,
      ...(result.duplicate ? { duplicate: true } : {}),
      current: result.current,
      limit: ctx.limit,
      remaining: ctx.limit === null ? null : Math.max(0, ctx.limit - result.current),
      resetAt: ctx.resetAt,
      upgradeAvailable: ctx.upgradeAvailable,
    };
  }

  /**
   * Reserve one operation's usage before any model call. The SERVER chooses the operation id
   * (`operationId`, never a client value); the unit is counted at once, so quota cannot be
   * oversubscribed by concurrent requests. `inFlightKey` (already scoped to the user and the
   * logical request by the caller) rejects an identical operation of the same user while one
   * is still running (409 AI_OPERATION_IN_PROGRESS) — no duplicate model execution.
   *
   * Lifecycle: the reservation holds a lease the running process renews ({@link renewLease}).
   * It ends with {@link commit} (charged) or {@link releaseReservation} (refunded, only if
   * nothing was delivered). A reservation whose lease expired — its process died — is
   * recovered by {@link recoverExpiredReservations}: charged if output had been delivered
   * ({@link markDelivered}), otherwise refunded. An active operation is never recovered.
   */
  async reserve(input: {
    workspaceId: string;
    userId: string;
    metric: UsageMetric;
    operationId: string;
    inFlightKey?: string;
    quantity?: number;
  }): Promise<UsageReservation> {
    if (input.metric === 'pr_review') {
      throw workspaceException('USAGE_LIMIT_REACHED', 'Unsupported usage metric.');
    }
    const quantity = input.quantity ?? 1;
    const ctx = await this.limitContext(input.workspaceId, input.metric);
    // Decision 1: before any quota is touched (and so before any model call).
    if (ctx.planId === 'free' && FREE_AI_METRICS.has(input.metric)) {
      await this.assertVerifiedForFreeAi(input.workspaceId, input.userId);
    }
    await this.recoverExpiredReservations(input.workspaceId);
    const idempotencyKey = `op:${input.operationId}`;
    let charged: { allowed: boolean; current: number };
    try {
      charged = await this.prisma.$transaction(async (tx) => {
        const result = await this.incrementWithinLimit(
          tx,
          { workspaceId: input.workspaceId, metric: input.metric, periodKey: ctx.period, quantity },
          ctx.limit,
        );
        if (!result.allowed) return result;
        // A unique violation (identical in-flight operation) rolls back the increment.
        await tx.workspaceUsageEvent.create({
          data: {
            workspaceId: input.workspaceId,
            metric: input.metric,
            periodKey: ctx.period,
            idempotencyKey,
            quantity,
            status: 'reserved',
            userId: input.userId,
            inFlightKey: input.inFlightKey ?? null,
            requestKey: input.inFlightKey ?? null,
            leaseExpiresAt: new Date(Date.now() + LEASE_MS),
          },
        });
        return result;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw workspaceException(
          'AI_OPERATION_IN_PROGRESS',
          'The same request is already in progress. Wait for it to finish before trying again.',
        );
      }
      throw error;
    }
    if (!charged.allowed) {
      if (ctx.planId === 'free' && FREE_AI_METRICS.has(input.metric)) {
        this.recordFreeAiEvent('ai.free_quota.exhausted', input.workspaceId, input.userId, {
          metric: input.metric,
          used: charged.current,
        });
      }
      throw this.limitReached(input.metric, ctx, charged.current);
    }
    return {
      workspaceId: input.workspaceId,
      metric: input.metric,
      idempotencyKey,
      operationId: input.operationId,
      quantity,
    };
  }

  /**
   * Decision 1: free AI quota is consumed only by a verified account, in a workspace whose
   * owner(s) verified too. Read fresh (never cached) so verifying unlocks usage at once.
   * The owner rule closes the multiplication path where one verified account is invited into
   * many throwaway, unverified accounts' free workspaces and burns each one's pool.
   * The rejection names no other user and no workspace data.
   */
  private async assertVerifiedForFreeAi(workspaceId: string, userId: string): Promise<void> {
    const [actor, owners] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { emailVerifiedAt: true } }),
      this.prisma.workspaceMembership.findMany({
        where: { workspaceId, role: 'owner', status: 'active' },
        select: { user: { select: { emailVerifiedAt: true } } },
      }),
    ]);
    let reason: 'account' | 'workspace_owner' | null = null;
    if (!actor?.emailVerifiedAt) reason = 'account';
    else if (owners.length === 0 || owners.some((o) => !o.user.emailVerifiedAt)) {
      reason = 'workspace_owner';
    }
    if (!reason) return;
    this.recordFreeAiEvent('ai.free_quota.verification_required', workspaceId, userId, {
      reason,
    });
    throw workspaceException(
      'EMAIL_VERIFICATION_REQUIRED',
      reason === 'account'
        ? 'Confirm your email address to use free AI actions. Check your inbox or request a new verification link.'
        : "This workspace's owner must confirm their email address before its free AI actions can be used.",
      { reason },
    );
  }

  /** Abuse-monitoring signal: structured log + durable security audit (never throws). */
  private recordFreeAiEvent(
    type: 'ai.free_quota.verification_required' | 'ai.free_quota.exhausted',
    workspaceId: string,
    userId: string,
    detail: Record<string, string | number>,
  ): void {
    this.logger.warn({ msg: type, workspaceId, userId, ...detail });
    try {
      this.securityAudit?.record({
        type,
        outcome: 'blocked',
        actorUserId: userId,
        workspaceId,
        detail: Object.entries(detail)
          .map(([key, value]) => `${key}=${value}`)
          .join(' '),
      });
    } catch {
      // monitoring never blocks the request path
    }
  }

  /**
   * F-06 / F-07 — settle an operation for which the AI provider has ALREADY done work (a model
   * call was started or completed) but the user got no usable result: the client disconnected
   * mid-review, or the model output could not be used.
   *
   * Refunding these unconditionally made provider spend free and unlimited: start a review,
   * hang up before the end, repeat — the monthly counter never moved. Charging them always
   * would bill an honest user for every network drop or model hiccup. So the refund is kept
   * but BUDGETED: each user gets {@link PROVIDER_WORK_REFUNDS_PER_PERIOD} such refunds per
   * workspace per usage period (the same monthly period as the quota — a daily budget would
   * refill thirty times against one monthly quota); past that the unit is charged. The budget is one conditional
   * UPDATE on a counter row (same mechanism as the quota), so concurrent settlements cannot
   * overspend it, and it is durable across restarts and instances.
   *
   * Never used when no provider call was made (those are plain refunds).
   */
  async settleAfterProviderWork(
    reservation: UsageReservation,
    userId: string,
    now = new Date(),
  ): Promise<'refunded' | 'charged' | 'missing'> {
    const key = {
      workspaceId: reservation.workspaceId,
      metric: `${PROVIDER_WORK_REFUND_METRIC}:${userId}`,
      periodKey: usagePeriodKey(now),
    };
    const granted = await this.prisma.$transaction(async (tx) => {
      await tx.workspaceUsageCounter.createMany({
        data: [{ ...key, count: 0 }],
        skipDuplicates: true,
      });
      const updated = await tx.workspaceUsageCounter.updateMany({
        where: { ...key, count: { lte: PROVIDER_WORK_REFUNDS_PER_PERIOD - 1 } },
        data: { count: { increment: 1 } },
      });
      return updated.count === 1;
    });
    if (granted) {
      const released = await this.releaseReservation(reservation);
      if (!released) {
        // Nothing to refund (already settled): hand the budget unit back.
        await this.prisma.workspaceUsageCounter.updateMany({
          where: { ...key, count: { gte: 1 } },
          data: { count: { decrement: 1 } },
        });
        return 'missing';
      }
      return 'refunded';
    }
    const charged = await this.commit(reservation);
    if (charged) {
      this.logger.warn({
        msg: 'usage.provider_work.charged',
        workspaceId: reservation.workspaceId,
        userId,
        metric: reservation.metric,
        operationId: reservation.operationId,
      });
    }
    return charged ? 'charged' : 'missing';
  }

  /** Heartbeat: extend the lease of a running operation. False when it is no longer open. */
  async renewLease(reservation: UsageReservation, now = new Date()): Promise<boolean> {
    const updated = await this.prisma.workspaceUsageEvent.updateMany({
      where: {
        workspaceId: reservation.workspaceId,
        idempotencyKey: reservation.idempotencyKey,
        status: 'reserved',
      },
      data: { leaseExpiresAt: new Date(now.getTime() + LEASE_MS) },
    });
    return updated.count === 1;
  }

  /**
   * Record that output reached the client. From then on the unit is owed: a refund is no
   * longer possible and recovery charges it. Idempotent.
   */
  async markDelivered(reservation: UsageReservation): Promise<boolean> {
    const updated = await this.prisma.workspaceUsageEvent.updateMany({
      where: {
        workspaceId: reservation.workspaceId,
        idempotencyKey: reservation.idempotencyKey,
        status: { in: ['reserved', 'committed'] },
        deliveredAt: null,
      },
      data: { deliveredAt: new Date() },
    });
    return updated.count === 1 || (await this.statusOf(reservation)) !== null;
  }

  /**
   * Finalize a reservation as charged, optionally keeping a short-lived copy of the result
   * for a lost-response retry ({@link findReplay}). Idempotent: committing an already
   * committed operation succeeds again without charging twice. False only when the
   * reservation no longer exists (it was refunded).
   */
  async commit(
    reservation: UsageReservation,
    result?: { text: string; meta?: Prisma.InputJsonValue },
  ): Promise<boolean> {
    const now = new Date();
    const updated = await this.prisma.workspaceUsageEvent.updateMany({
      where: {
        workspaceId: reservation.workspaceId,
        idempotencyKey: reservation.idempotencyKey,
        status: 'reserved',
      },
      data: {
        status: 'committed',
        inFlightKey: null,
        finalizedAt: now,
        leaseExpiresAt: null,
        ...(result
          ? {
              resultText: result.text,
              ...(result.meta !== undefined ? { resultMeta: result.meta } : {}),
              resultExpiresAt: new Date(now.getTime() + REPLAY_WINDOW_MS),
            }
          : {}),
      },
    });
    if (updated.count === 1) return true;
    return (await this.statusOf(reservation)) === 'committed';
  }

  /**
   * Refund a reservation that was never committed and never delivered. Idempotent; never
   * touches a charge, and never refunds work that reached the client.
   */
  async releaseReservation(reservation: UsageReservation): Promise<boolean> {
    return this.release({
      workspaceId: reservation.workspaceId,
      metric: reservation.metric,
      idempotencyKey: reservation.idempotencyKey,
      onlyReserved: true,
    });
  }

  private async statusOf(reservation: UsageReservation): Promise<string | null> {
    const row = await this.prisma.workspaceUsageEvent.findUnique({
      where: {
        workspaceId_idempotencyKey: {
          workspaceId: reservation.workspaceId,
          idempotencyKey: reservation.idempotencyKey,
        },
      },
      select: { status: true },
    });
    return row?.status ?? null;
  }

  /**
   * Recover reservations whose process died: lease expired (or, for reservations created
   * before leases existed, older than {@link LEGACY_RESERVATION_TTL_MS}). Delivered output is
   * charged, undelivered work refunded. Also clears expired replay copies. Runs lazily
   * before each new reservation in the workspace; safe to run concurrently (each row is
   * settled by exactly one conditional statement).
   */
  async recoverExpiredReservations(
    workspaceId: string,
    now = new Date(),
  ): Promise<{ charged: number; refunded: number }> {
    const expired = await this.prisma.workspaceUsageEvent.findMany({
      where: {
        workspaceId,
        status: 'reserved',
        OR: [
          { leaseExpiresAt: { lt: now } },
          {
            leaseExpiresAt: null,
            createdAt: { lt: new Date(now.getTime() - LEGACY_RESERVATION_TTL_MS) },
          },
        ],
      },
      select: { idempotencyKey: true, metric: true, deliveredAt: true },
      take: 50,
    });
    const out = { charged: 0, refunded: 0 };
    for (const row of expired) {
      const reservation: UsageReservation = {
        workspaceId,
        metric: row.metric as UsageMetric,
        idempotencyKey: row.idempotencyKey,
        operationId: row.idempotencyKey.replace(/^op:/, ''),
        quantity: 1,
      };
      if (row.deliveredAt) {
        // Only if still reserved with an expired lease: a live heartbeat may have renewed it.
        const done = await this.prisma.workspaceUsageEvent.updateMany({
          where: {
            workspaceId,
            idempotencyKey: row.idempotencyKey,
            status: 'reserved',
            leaseExpiresAt: { lt: now },
          },
          data: { status: 'committed', inFlightKey: null, finalizedAt: now, leaseExpiresAt: null },
        });
        if (done.count === 1) out.charged += 1;
      } else if (await this.release({ ...reservation, onlyReserved: true, expiredBefore: now })) {
        out.refunded += 1;
      }
    }
    await this.prisma.workspaceUsageEvent.updateMany({
      where: { workspaceId, resultExpiresAt: { lt: now } },
      data: { resultText: null, resultMeta: Prisma.DbNull, resultExpiresAt: null },
    });
    return out;
  }

  /**
   * The stored result of a COMPLETED operation, for a retry whose response was lost: only for
   * the same user, the same workspace, the same logical request, and within the replay
   * window. Anything else (unknown, refunded, someone else's, a different request, expired)
   * returns null and the caller runs a new, normally charged operation.
   */
  async findReplay(input: {
    workspaceId: string;
    userId: string;
    operationId: string;
    requestKey: string;
    now?: Date;
  }): Promise<{ text: string; meta: Prisma.JsonValue | null } | null> {
    if (!/^[0-9a-f-]{36}$/i.test(input.operationId)) return null;
    const row = await this.prisma.workspaceUsageEvent.findUnique({
      where: {
        workspaceId_idempotencyKey: {
          workspaceId: input.workspaceId,
          idempotencyKey: `op:${input.operationId}`,
        },
      },
      select: {
        status: true,
        userId: true,
        requestKey: true,
        resultText: true,
        resultMeta: true,
        resultExpiresAt: true,
      },
    });
    const now = input.now ?? new Date();
    if (
      !row ||
      row.status !== 'committed' ||
      row.userId !== input.userId ||
      row.requestKey !== input.requestKey ||
      row.resultText == null ||
      !row.resultExpiresAt ||
      row.resultExpiresAt <= now
    ) {
      return null;
    }
    // One replay per stored result: the copy is erased as it is handed out (only the caller
    // that clears it gets it), so a delivered output is never kept longer than needed.
    const taken = await this.prisma.workspaceUsageEvent.updateMany({
      where: {
        workspaceId: input.workspaceId,
        idempotencyKey: `op:${input.operationId}`,
        resultExpiresAt: { gt: now },
      },
      data: { resultText: null, resultMeta: Prisma.DbNull, resultExpiresAt: null },
    });
    if (taken.count !== 1) return null;
    return { text: row.resultText, meta: row.resultMeta };
  }

  async release(input: {
    workspaceId: string;
    metric: UsageMetric;
    idempotencyKey: string;
    /**
     * Only refund an open reservation: never a final charge, never delivered work.
     */
    onlyReserved?: boolean;
    /** Recovery: only if the lease expired before this time (a live heartbeat wins). */
    expiredBefore?: Date;
  }): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      // DELETE … RETURNING: of two concurrent releases exactly one removes the row and refunds.
      const statusFilter = input.onlyReserved
        ? Prisma.sql`AND "status" = 'reserved' AND "delivered_at" IS NULL`
        : Prisma.empty;
      const leaseFilter = input.expiredBefore
        ? Prisma.sql`AND ("lease_expires_at" IS NULL OR "lease_expires_at" < ${input.expiredBefore})`
        : Prisma.empty;
      const removed = await tx.$queryRaw<{ quantity: number; period_key: string }[]>`
        DELETE FROM "workspace_usage_events"
        WHERE "workspace_id" = ${input.workspaceId}
          AND "idempotency_key" = ${input.idempotencyKey}
          AND "metric" = ${input.metric}
          ${statusFilter}
          ${leaseFilter}
        RETURNING "quantity", "period_key"`;
      const event = removed[0];
      if (!event) return false;
      await tx.workspaceUsageCounter.updateMany({
        where: {
          workspaceId: input.workspaceId,
          metric: input.metric,
          periodKey: event.period_key,
          count: { gte: event.quantity },
        },
        data: { count: { decrement: event.quantity } },
      });
      return true;
    });
  }
}

/**
 * F-06 / F-07: refunds per user, per workspace, per usage period (calendar month, UTC) for
 * operations whose provider work was already done (cancelled mid-run, unusable output). Past
 * it, the unit is charged.
 */
export const PROVIDER_WORK_REFUNDS_PER_PERIOD = 5;
/** Internal counter key (never listed with the plan metrics). */
export const PROVIDER_WORK_REFUND_METRIC = 'provider_work_refund';

/** Lease of a running operation; the holder renews it every {@link LEASE_RENEW_MS}. */
export const LEASE_MS = 2 * 60 * 1000;
export const LEASE_RENEW_MS = 30 * 1000;
/** Reservations created before leases existed are recovered by age. */
export const LEGACY_RESERVATION_TTL_MS = 30 * 60 * 1000;
/**
 * How long a delivered result can be replayed (once) to a retry whose response was lost.
 * Clients retry within seconds to minutes; the copy is erased on replay or expiry.
 */
export const REPLAY_WINDOW_MS = 10 * 60 * 1000;
/** Interval of the maintenance sweep (expired leases, expired replay copies). */
export const SWEEP_INTERVAL_MS = 60 * 1000;

/** Idempotent settlement writes are retried on transient failure (3 attempts, backoff). */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseMs = 50): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, baseMs * 4 ** i));
    }
  }
  throw last;
}

/** A server-created usage reservation (see {@link UsageService.reserve}). */
export type UsageReservation = {
  workspaceId: string;
  metric: UsageMetric;
  idempotencyKey: string;
  /** Server-generated operation id (returned to the client for retries). */
  operationId: string;
  quantity: number;
};

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function limitForMetric(entitlements: ProductEntitlements, metric: UsageMetric): number | null {
  if (metric === 'pr_review') {
    return null;
  }
  const key = METRIC_LIMIT_KEY[metric];
  const value = entitlements[key];
  return typeof value === 'number' || value === null ? value : null;
}
