import { randomBytes } from 'node:crypto';

import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { getProductPlan } from '@project-x/shared';
import type {
  BillingCheckoutResponse,
  BillingPlanPrices,
  BillingCycle,
  BillingPortalResponse,
  CreateBillingCheckoutRequest,
  ProductPlanId,
  WorkspaceBillingView,
} from '@project-x/types';

import type { ApiConfig } from '../config/configuration';
import { EntitlementService, effectivePlanId } from '../entitlements/entitlements.service';
import { MetricsService } from '../observability/metrics.service';
import { ProviderHealthService } from '../observability/provider-health.service';
import { SecurityAuditService } from '../observability/security-audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { UsageService } from '../usage/usage.service';
import { workspaceException } from '../workspaces/workspace.errors';
import {
  createBillingProvider,
  PaddleBillingProvider,
  type BillingProvider,
  type NormalizedProviderSubscription,
} from './billing-provider';

type PaidPlan = { planId: Exclude<ProductPlanId, 'free'>; billingCycle: BillingCycle };

function parseProviderTime(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

const PRICE_CACHE_TTL_MS = 10 * 60_000;
/**
 * A subscription the provider CONFIRMS as unknown this many times in a row is closed (F-03:
 * confirmed answers only — errors, timeouts and outages never count toward it).
 */
const NOT_FOUND_TERMINAL_ATTEMPTS = 3;
/** F-23: a pending checkout for the same plan is reused for this long instead of duplicated. */
const CHECKOUT_REUSE_MS = 30 * 60_000;
/** A checkout row whose provider transaction is still being created (no URL yet). */
const CHECKOUT_PREPARING_MS = 60_000;
/** Upper bound for one billing-provider call (the Paddle SDK sets no request timeout). */
const PROVIDER_CALL_TIMEOUT_MS = 15_000;

/** 1 min, 2, 4 … capped at 1 h. */
function cancellationBackoffMs(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 60 * 60_000);
}

class TimeoutError extends Error {
  override name = 'TimeoutError';
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError('provider call timed out')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Subscription statuses the provider may still bill, or resume billing from. */
export const BILLABLE_SUBSCRIPTION_STATUSES: ReadonlySet<string> = new Set([
  'trialing',
  'active',
  'past_due',
  'paused',
]);

export type DeletionCancellation =
  /** Nothing billable: no subscription, free plan, or already cancelled / expired. */
  | 'none'
  /** The provider cancelled the subscription immediately. */
  | 'cancelled_with_provider'
  /** The provider already had it cancelled (e.g. an earlier attempt or the portal). */
  | 'already_cancelled_with_provider'
  /** A billable row with no provider subscription (nothing external to cancel). */
  | 'cancelled_locally';

function normalizeBillingEventType(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes('subscription')) return 'subscription';
  if (lower.includes('transaction') || lower.includes('payment')) return 'transaction';
  if (lower.includes('customer')) return 'customer';
  return 'other';
}

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);
  private readonly provider: BillingProvider;
  private priceCache: { prices: BillingPlanPrices; expiresAt: number } | null = null;
  /** Upper bound for one provider call during cancellation (overridable in tests). */
  providerCallTimeoutMs = PROVIDER_CALL_TIMEOUT_MS;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<ApiConfig, true>,
    private readonly entitlements: EntitlementService,
    private readonly usage: UsageService,
    @Optional() private readonly metrics?: MetricsService,
    @Optional() private readonly providerHealth?: ProviderHealthService,
    @Optional() private readonly audit?: SecurityAuditService,
  ) {
    this.provider = createBillingProvider({
      nodeEnv: this.config.get('nodeEnv', { infer: true }),
      deploymentStage: this.config.get('deploymentStage', { infer: true }),
      paddle: this.config.get('paddle', { infer: true }),
    });
  }

  async getBillingView(workspaceId: string): Promise<WorkspaceBillingView> {
    // Derive the plan from the same row the view shows, never from a cache that may
    // lag a webhook that just landed.
    const row = await this.prisma.workspaceSubscription.findUnique({ where: { workspaceId } });
    const planId = effectivePlanId(row);
    const plan = getProductPlan(planId);
    const entitlements = plan.entitlements;
    const usage = await this.usage.getUsageCounters(workspaceId);
    const seatsUsed = await this.prisma.workspaceMembership.count({
      where: { workspaceId, status: 'active' },
    });
    const paddle = this.config.get('paddle', { infer: true });

    return {
      subscription: {
        id: row?.id ?? `local-${workspaceId}`,
        workspaceId,
        provider: 'paddle',
        planId,
        status: (row?.status as WorkspaceBillingView['subscription']['status']) ?? 'none',
        ...(row?.billingCycle === 'monthly' || row?.billingCycle === 'yearly'
          ? { billingCycle: row.billingCycle }
          : {}),
        ...(row?.currentPeriodStart
          ? { currentPeriodStart: row.currentPeriodStart.toISOString() }
          : {}),
        ...(row?.currentPeriodEnd ? { currentPeriodEnd: row.currentPeriodEnd.toISOString() } : {}),
        cancelAtPeriodEnd: row?.cancelAtPeriodEnd ?? false,
        createdAt: (row?.createdAt ?? new Date()).toISOString(),
        updatedAt: (row?.updatedAt ?? new Date()).toISOString(),
      },
      plan,
      entitlements,
      usage,
      seats: {
        used: seatsUsed,
        limit: entitlements.maxWorkspaceMembers,
      },
      ...(paddle.clientToken ? { paddleClientToken: paddle.clientToken } : {}),
      environment: paddle.environment,
      prices: await this.getPlanPrices(),
    };
  }

  /** Paddle list prices for the configured plans. Never fails the billing view. */
  private async getPlanPrices(): Promise<BillingPlanPrices> {
    if (this.priceCache && this.priceCache.expiresAt > Date.now()) {
      return this.priceCache.prices;
    }
    const refs = this.config.get('paddle', { infer: true }).prices;
    const slots = [
      ['pro', 'monthly', refs.proMonthly],
      ['pro', 'yearly', refs.proYearly],
      ['team', 'monthly', refs.teamMonthly],
      ['team', 'yearly', refs.teamYearly],
    ] as const;
    try {
      const ids = slots.map(([, , id]) => id).filter(Boolean);
      const byId = ids.length > 0 ? await this.provider.getPrices(ids) : {};
      const prices: BillingPlanPrices = {};
      for (const [planId, cycle, id] of slots) {
        const price = id ? byId[id] : undefined;
        if (price) {
          prices[planId] = { ...prices[planId], [cycle]: price };
        }
      }
      this.priceCache = { prices, expiresAt: Date.now() + PRICE_CACHE_TTL_MS };
      return prices;
    } catch (error) {
      this.logger.warn({
        msg: 'billing.prices.unavailable',
        error: error instanceof Error ? error.message : 'unknown',
      });
      return this.priceCache?.prices ?? {};
    }
  }

  async createCheckout(
    workspaceId: string,
    userEmail: string,
    input: CreateBillingCheckoutRequest,
  ): Promise<BillingCheckoutResponse> {
    const paddle = this.config.get('paddle', { infer: true });
    const priceId = this.resolvePriceId(input.planId, input.billingCycle);
    if (!priceId && (paddle.environment === 'production' || this.usesRealPaddle())) {
      throw workspaceException(
        'BILLING_CONFIGURATION_INVALID',
        `Billing price for ${input.planId} (${input.billingCycle}) is not configured.`,
      );
    }
    const resolvedPriceId = priceId || `sandbox_${input.planId}_${input.billingCycle}`;

    // An existing paid subscription is switched in place. A new checkout would create a
    // second Paddle subscription and bill the customer for both.
    const row = await this.prisma.workspaceSubscription.findUnique({ where: { workspaceId } });
    if (row?.providerSubscriptionId && effectivePlanId(row) !== 'free') {
      return this.changePlan(workspaceId, row.providerSubscriptionId, resolvedPriceId, input, {
        planId: effectivePlanId(row),
        billingCycle: row.billingCycle,
      });
    }

    // F-02 / F-23: every checkout is recorded BEFORE the provider is asked to create it. Its id
    // is the binding secret the webhook must present; an open checkout for the same plan is
    // reused (same provider transaction ⇒ at most one subscription), not duplicated.
    const opened = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${workspaceId} FOR UPDATE`;
      const recent = await tx.billingCheckout.findFirst({
        where: {
          workspaceId,
          status: 'pending',
          planId: input.planId,
          billingCycle: input.billingCycle,
          createdAt: { gte: new Date(Date.now() - CHECKOUT_REUSE_MS) },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (recent?.providerTransactionId && recent.checkoutUrl) {
        return { reuse: recent, id: null };
      }
      if (recent && recent.createdAt.getTime() > Date.now() - CHECKOUT_PREPARING_MS) {
        throw workspaceException(
          'BILLING_CHECKOUT_FAILED',
          'A checkout for this plan is already being prepared. Try again in a moment.',
        );
      }
      const id = `chk_${randomBytes(16).toString('hex')}`;
      await tx.billingCheckout.create({
        data: { id, workspaceId, planId: input.planId, billingCycle: input.billingCycle },
      });
      return { reuse: null, id };
    });
    if (opened.reuse) {
      return {
        transactionId: opened.reuse.providerTransactionId!,
        checkoutUrl: opened.reuse.checkoutUrl!,
        planId: input.planId,
        billingCycle: input.billingCycle,
      };
    }

    const appBaseUrl = this.config.get('appBaseUrl', { infer: true });
    try {
      const result = await this.provider.createCheckout({
        workspaceId,
        checkoutId: opened.id!,
        planId: input.planId,
        billingCycle: input.billingCycle,
        customerEmail: userEmail,
        priceId: resolvedPriceId,
        successUrl: `${appBaseUrl}/app/billing`,
      });
      await this.prisma.billingCheckout.update({
        where: { id: opened.id! },
        data: {
          providerTransactionId: result.transactionId ?? null,
          checkoutUrl: result.checkoutUrl ?? null,
        },
      });
      this.metrics?.recordBillingCheckout('success');
      return result;
    } catch (error) {
      // No provider transaction carries this id: the record is useless, drop it.
      await this.prisma.billingCheckout
        .deleteMany({ where: { id: opened.id!, providerSubscriptionId: null } })
        .catch(() => undefined);
      this.metrics?.recordBillingCheckout('failure');
      this.logger.warn({
        msg: 'billing.checkout.failed',
        error: error instanceof Error ? error.message : 'unknown',
      });
      throw workspaceException('BILLING_CHECKOUT_FAILED', 'Unable to start checkout.');
    }
  }

  /**
   * Apply provider state read by a PULL path (plan change, cancel, refresh) under the same
   * workspace row lock the webhook takes, so a pull that started before a newer webhook
   * committed cannot overwrite it with older state (the ordering check then sees the row the
   * webhook wrote).
   */
  private async applyLocked(
    workspaceId: string,
    remote: NormalizedProviderSubscription,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM workspaces WHERE id = ${workspaceId} FOR UPDATE`;
      return this.applySubscription(tx, workspaceId, remote);
    });
  }

  private async changePlan(
    workspaceId: string,
    providerSubscriptionId: string,
    priceId: string,
    input: CreateBillingCheckoutRequest,
    current: { planId: ProductPlanId; billingCycle: string | null },
  ): Promise<BillingCheckoutResponse> {
    if (current.planId === input.planId && current.billingCycle === input.billingCycle) {
      throw workspaceException('BILLING_CHECKOUT_FAILED', 'Workspace is already on this plan.');
    }
    let updated: NormalizedProviderSubscription;
    try {
      updated = await this.provider.changeSubscriptionPrice(providerSubscriptionId, priceId);
    } catch (error) {
      this.logger.warn({
        msg: 'billing.subscription.change_failed',
        workspaceId,
        error: error instanceof Error ? error.message : 'unknown',
      });
      throw workspaceException(
        'BILLING_SUBSCRIPTION_UPDATE_FAILED',
        'Unable to change the subscription plan.',
      );
    }
    // Apply now so the UI reflects the change; the subscription.updated webhook that
    // follows carries the same (or a newer) state.
    await this.applyLocked(workspaceId, updated);
    this.entitlements.invalidate(workspaceId);
    return {
      planId: input.planId,
      billingCycle: input.billingCycle,
      subscriptionUpdated: true,
    };
  }

  private usesRealPaddle(): boolean {
    return this.provider instanceof PaddleBillingProvider;
  }

  async createPortal(workspaceId: string): Promise<BillingPortalResponse> {
    const row = await this.prisma.workspaceSubscription.findUnique({ where: { workspaceId } });
    if (!row?.providerCustomerId) {
      throw workspaceException(
        'BILLING_CONFIGURATION_INVALID',
        'No billing customer for this workspace.',
      );
    }
    const hardened = this.config.get('nodeEnv', { infer: true }) === 'production';
    const appBaseUrl = this.config.get('appBaseUrl', { infer: true });
    const url = await this.provider.getPortalLink(
      row.providerCustomerId,
      `${appBaseUrl}/app/billing`,
      row.providerSubscriptionId ?? undefined,
    );
    // Production AND staging (both NODE_ENV=production): https on a Paddle host only. The
    // local sandbox provider returns a local http URL, accepted outside production only.
    if (!url.startsWith('https://') && !(url.startsWith('http://') && !hardened)) {
      throw workspaceException('BILLING_PROVIDER_UNAVAILABLE', 'Invalid portal URL.');
    }
    // Prefer Paddle-hosted portal domains when a full URL is returned.
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      const allowed =
        (host === 'localhost' && !hardened) ||
        host.endsWith('.paddle.com') ||
        host.endsWith('.paddle.io') ||
        host === 'sandbox-api.paddle.com' ||
        host === 'api.paddle.com';
      if (!allowed && hardened) {
        throw workspaceException('BILLING_PROVIDER_UNAVAILABLE', 'Invalid portal URL.');
      }
    } catch (error) {
      if (error && typeof error === 'object' && 'getStatus' in error) {
        throw error;
      }
      throw workspaceException('BILLING_PROVIDER_UNAVAILABLE', 'Invalid portal URL.');
    }
    return { url };
  }

  async cancel(workspaceId: string, _userId: string): Promise<WorkspaceBillingView> {
    const row = await this.prisma.workspaceSubscription.findUnique({ where: { workspaceId } });
    if (!row?.providerSubscriptionId) {
      await this.prisma.workspaceSubscription.upsert({
        where: { workspaceId },
        create: {
          workspaceId,
          provider: 'paddle',
          planId: row?.planId ?? 'free',
          status: 'cancelled',
          cancelAtPeriodEnd: true,
        },
        update: { status: 'cancelled', cancelAtPeriodEnd: true },
      });
    } else {
      const normalized = await this.provider.cancelSubscription(row.providerSubscriptionId, true);
      await this.applyLocked(workspaceId, normalized);
    }
    this.entitlements.invalidate(workspaceId);
    return this.getBillingView(workspaceId);
  }

  /**
   * Workspace deletion, step 1 (inside the caller's short deletion transaction): decide what
   * must be cancelled and record it DURABLY. No provider call happens here (N-11). A billable
   * row with a provider subscription becomes a BillingCancellationRequest; a billable row
   * without one is cancelled locally. Billing history (events, usage, the row) is kept.
   */
  async recordDeletionCancellation(
    db: Prisma.TransactionClient,
    workspaceId: string,
  ): Promise<'none' | 'requested' | 'cancelled_locally'> {
    const row = await db.workspaceSubscription.findUnique({ where: { workspaceId } });
    // F-23: a second subscription that came out of one of this workspace's checkouts while
    // another was still billable is tracked on its checkout row. Deleting the workspace must
    // cancel those too — not only the one the subscription row points at.
    const tracked = await db.billingCheckout.findMany({
      where: {
        workspaceId,
        providerSubscriptionId: { not: null },
        subscriptionStatus: { in: [...BILLABLE_SUBSCRIPTION_STATUSES] },
      },
      select: { providerSubscriptionId: true },
    });
    let requestedTracked = false;
    for (const checkout of tracked) {
      if (checkout.providerSubscriptionId === row?.providerSubscriptionId) continue;
      await this.requestCancellation(
        db,
        workspaceId,
        checkout.providerSubscriptionId!,
        'workspace_deletion',
      );
      requestedTracked = true;
    }
    if (!row || row.planId === 'free' || !BILLABLE_SUBSCRIPTION_STATUSES.has(row.status)) {
      return requestedTracked ? 'requested' : 'none';
    }
    if (!row.providerSubscriptionId) {
      await db.workspaceSubscription.update({
        where: { workspaceId },
        data: { status: 'cancelled', cancelAtPeriodEnd: false },
      });
      this.logger.warn({ msg: 'billing.deletion.local_subscription_cancelled', workspaceId });
      return 'cancelled_locally';
    }
    await this.requestCancellation(
      db,
      workspaceId,
      row.providerSubscriptionId,
      'workspace_deletion',
    );
    return 'requested';
  }

  /**
   * Durably require that `providerSubscriptionId` be cancelled (idempotent per subscription).
   * Never disturbs a request that is pending or in flight. A COMPLETED request is reopened
   * only by a late webhook that reports the subscription billable again (re-activation).
   */
  private async requestCancellation(
    db: Prisma.TransactionClient,
    workspaceId: string,
    providerSubscriptionId: string,
    reason: 'workspace_deletion' | 'late_webhook',
  ): Promise<void> {
    const existing = await db.billingCancellationRequest.findUnique({
      where: { providerSubscriptionId },
      select: { status: true },
    });
    if (!existing) {
      await db.billingCancellationRequest.create({
        data: { workspaceId, providerSubscriptionId, reason, status: 'pending' },
      });
      return;
    }
    if (existing.status === 'done' && reason === 'late_webhook') {
      await db.billingCancellationRequest.update({
        where: { providerSubscriptionId },
        // A reopened request starts over: earlier attempts must not make its first failure
        // terminal (F-03).
        data: {
          status: 'pending',
          nextAttemptAt: new Date(),
          completedAt: null,
          reason,
          attempts: 0,
          notFoundCount: 0,
          lastErrorCode: null,
        },
      });
    }
  }

  /** Open (not yet confirmed) cancellation requests of a workspace. */
  async openCancellationCount(db: Prisma.TransactionClient, workspaceId: string): Promise<number> {
    return db.billingCancellationRequest.count({
      where: { workspaceId, status: { in: ['pending', 'processing'] } },
    });
  }

  /**
   * Wait (bounded by the claim lease) while another processor's provider call for this
   * workspace is in flight, so concurrent deletion requests observe its outcome instead of
   * failing early. Returns once nothing is `processing` (or the lease would have expired).
   */
  async waitForInFlightCancellations(workspaceId: string): Promise<void> {
    const deadline = Date.now() + this.cancellationLeaseMs();
    while (Date.now() < deadline) {
      const inFlight = await this.prisma.billingCancellationRequest.count({
        where: { workspaceId, status: 'processing', nextAttemptAt: { gt: new Date() } },
      });
      if (inFlight === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  private cancellationLeaseMs(): number {
    // Two provider calls (cancel, then verify) plus a margin.
    return this.providerCallTimeoutMs * 2 + 5_000;
  }

  /**
   * Process cancellation requests OUTSIDE any database transaction (N-11): for one workspace
   * (deletion), or every due request (reconciler). Each request is claimed with a short lease
   * so concurrent processors never call the provider twice for it; the provider call is
   * bounded by a timeout. Success means the provider CONFIRMED a non-billable state (directly,
   * or on verification after an error); anything else is retried later with backoff and
   * surfaced (log + audit). Returns the outcome of the requests processed now.
   */
  async processCancellationRequests(
    filter: { workspaceId?: string; limit?: number } = {},
  ): Promise<{ done: number; failed: number; outcomes: DeletionCancellation[] }> {
    const now = new Date();
    const due = await this.prisma.billingCancellationRequest.findMany({
      where: {
        OR: [
          // F-03: backoff is honoured for EVERY caller. An owner retrying the deletion must not
          // be able to burn through the retry schedule during a provider outage.
          { status: 'pending', nextAttemptAt: { lte: now } },
          // A claim whose processor died (lease expired) is taken over.
          { status: 'processing', nextAttemptAt: { lte: now } },
        ],
        ...(filter.workspaceId ? { workspaceId: filter.workspaceId } : {}),
      },
      orderBy: { nextAttemptAt: 'asc' },
      take: filter.limit ?? 25,
    });
    let done = 0;
    let failed = 0;
    const outcomes: DeletionCancellation[] = [];
    for (const request of due) {
      // Claim: only one processor works on a request at a time.
      const claimed = await this.prisma.billingCancellationRequest.updateMany({
        where: { id: request.id, status: request.status, updatedAt: request.updatedAt },
        data: {
          status: 'processing',
          nextAttemptAt: new Date(Date.now() + this.cancellationLeaseMs()),
        },
      });
      if (claimed.count !== 1) continue;
      const result = await this.cancelWithProvider(request.providerSubscriptionId);
      // F-03: only CONFIRMED "this subscription does not exist" answers count, and only an
      // unbroken streak of them. 401/403/429/5xx, network failures and timeouts are
      // `provider_error` / `timeout`: they reset the streak and are retried forever.
      const notFoundStreak =
        !result.ok && result.code === 'not_found' ? request.notFoundCount + 1 : 0;
      if (notFoundStreak >= NOT_FOUND_TERMINAL_ATTEMPTS) {
        // Adversarial N5: the provider repeatedly does not know this subscription, so it
        // cannot bill it. Close the request (terminal, loudly) instead of retrying forever.
        await this.prisma.billingCancellationRequest.update({
          where: { id: request.id },
          data: {
            status: 'done',
            completedAt: new Date(),
            attempts: request.attempts + 1,
            notFoundCount: notFoundStreak,
            lastErrorCode: 'not_found_terminal',
          },
        });
        this.logger.error({
          msg: 'billing.cancellation.subscription_not_found',
          workspaceId: request.workspaceId,
          reason: request.reason,
        });
        done += 1;
        outcomes.push('none');
        continue;
      }
      if (result.ok) {
        await this.prisma.$transaction(async (tx) => {
          await this.storeConfirmedCancellation(tx, request.workspaceId, result.remote);
          await tx.billingCancellationRequest.update({
            where: { id: request.id },
            data: {
              status: 'done',
              completedAt: new Date(),
              lastErrorCode: null,
              notFoundCount: 0,
            },
          });
        });
        this.entitlements.invalidate(request.workspaceId);
        done += 1;
        outcomes.push(result.outcome);
        this.logger.warn({
          msg: 'billing.cancellation.confirmed',
          workspaceId: request.workspaceId,
          reason: request.reason,
          outcome: result.outcome,
        });
      } else {
        const attempts = request.attempts + 1;
        await this.prisma.billingCancellationRequest.update({
          where: { id: request.id },
          data: {
            status: 'pending',
            attempts,
            notFoundCount: notFoundStreak,
            lastErrorCode: result.code,
            nextAttemptAt: new Date(Date.now() + cancellationBackoffMs(attempts)),
          },
        });
        failed += 1;
        this.logger.error({
          msg: 'billing.cancellation.retry_scheduled',
          workspaceId: request.workspaceId,
          reason: request.reason,
          attempts,
          errorCode: result.code,
        });
        try {
          this.audit?.record({
            type: 'billing.cancellation.failed',
            outcome: 'failure',
            workspaceId: request.workspaceId,
            detail: `reason=${request.reason} attempts=${attempts} code=${result.code}`,
          });
        } catch {
          // never break billing processing on audit
        }
      }
    }
    return { done, failed, outcomes };
  }

  /**
   * Immediate cancellation with verification; never assumes success. Outcomes (F-03):
   * - ok: the provider CONFIRMED a non-billable state (on cancel, or on the verifying read);
   * - `still_billable`: the provider answered and the subscription can still bill;
   * - `not_found`: the provider answered that the subscription does not exist (a confirmed
   *   404 — `getSubscription` resolves null for nothing else);
   * - `timeout` / `provider_error`: the provider did not give a usable answer (401, 403, 429,
   *   5xx, transport failure, timeout). Always retried.
   */
  private async cancelWithProvider(
    subscriptionId: string,
  ): Promise<
    | { ok: true; remote: NormalizedProviderSubscription; outcome: DeletionCancellation }
    | { ok: false; code: string }
  > {
    try {
      const remote = await withTimeout(
        this.provider.cancelSubscription(subscriptionId, false),
        this.providerCallTimeoutMs,
      );
      if (!BILLABLE_SUBSCRIPTION_STATUSES.has(remote.status)) {
        return { ok: true, remote, outcome: 'cancelled_with_provider' };
      }
    } catch {
      // Possibly already cancelled (an earlier attempt, the customer portal): verify.
    }
    try {
      const remote = await withTimeout(
        this.provider.getSubscription(subscriptionId),
        this.providerCallTimeoutMs,
      );
      if (remote && !BILLABLE_SUBSCRIPTION_STATUSES.has(remote.status)) {
        return { ok: true, remote, outcome: 'already_cancelled_with_provider' };
      }
      return { ok: false, code: remote ? 'still_billable' : 'not_found' };
    } catch (error) {
      return { ok: false, code: error instanceof TimeoutError ? 'timeout' : 'provider_error' };
    }
  }

  async refresh(workspaceId: string): Promise<WorkspaceBillingView> {
    const row = await this.prisma.workspaceSubscription.findUnique({ where: { workspaceId } });
    if (!row?.providerSubscriptionId) {
      return this.getBillingView(workspaceId);
    }
    const remote = await this.provider.getSubscription(row.providerSubscriptionId);
    if (remote) {
      await this.applyLocked(workspaceId, remote);
      this.entitlements.invalidate(workspaceId);
    }
    return this.getBillingView(workspaceId);
  }

  async handleWebhook(rawBody: Buffer, signature: string | undefined): Promise<{ ok: true }> {
    const startedAt = Date.now();
    if (!this.provider.verifyWebhook(rawBody, signature)) {
      this.metrics?.recordBillingWebhook('invalid_signature', 'invalid');
      this.metrics?.recordWebhook({
        provider: 'paddle',
        eventType: 'unknown',
        status: 'invalid_signature',
        durationSeconds: (Date.now() - startedAt) / 1000,
      });
      this.providerHealth?.recordSignal('paddle', false);
      throw workspaceException('BILLING_WEBHOOK_INVALID', 'Invalid webhook signature.');
    }

    let parsed: ReturnType<BillingProvider['parseWebhook']>;
    try {
      parsed = this.provider.parseWebhook(rawBody);
    } catch {
      this.metrics?.recordBillingWebhook('malformed', 'invalid');
      this.metrics?.recordWebhook({
        provider: 'paddle',
        eventType: 'malformed',
        status: 'invalid',
        durationSeconds: (Date.now() - startedAt) / 1000,
      });
      throw workspaceException('BILLING_WEBHOOK_INVALID', 'Malformed webhook payload.');
    }

    const eventType = normalizeBillingEventType(parsed.eventType);

    const recordDuplicate = (): { ok: true } => {
      this.metrics?.recordBillingWebhook(eventType, 'duplicate');
      this.metrics?.recordWebhook({
        provider: 'paddle',
        eventType,
        status: 'duplicate',
        durationSeconds: (Date.now() - startedAt) / 1000,
      });
      return { ok: true };
    };

    const existing = await this.prisma.billingWebhookEvent.findUnique({
      where: {
        provider_eventId: {
          provider: 'paddle',
          eventId: parsed.eventId,
        },
      },
    });
    if (existing) {
      return recordDuplicate();
    }

    // Record the event and apply it atomically: if applying fails, the event is not
    // marked processed, so Paddle's retry is handled instead of being acked as a duplicate.
    let applied = false;
    let cancellationRequested = false;
    try {
      applied = await this.prisma.$transaction(async (tx) => {
        await tx.billingWebhookEvent.create({
          data: {
            provider: 'paddle',
            eventId: parsed.eventId,
            eventType: parsed.eventType,
            payloadJson: {
              eventType: parsed.eventType,
              workspaceId: parsed.workspaceId ?? null,
              priceIds: parsed.subscription?.priceIds ?? [],
              status: parsed.subscription?.status ?? null,
            },
          },
        });
        if (!parsed.workspaceId || !parsed.subscription) {
          return false;
        }
        // Serialized with deletion (same workspace row lock, same order: workspace →
        // subscription), so a webhook can never slip between "pending" and the cancellation
        // decision (N-12).
        const workspace = await tx.$queryRaw<Array<{ status: string }>>`
          SELECT status FROM workspaces WHERE id = ${parsed.workspaceId} FOR UPDATE`;
        const status = workspace[0]?.status;
        const wasApplied = await this.applySubscription(
          tx,
          parsed.workspaceId,
          parsed.subscription,
          { checkoutId: parsed.checkoutId },
        );
        if (
          (status === 'deleted' || status === 'deletion_pending') &&
          parsed.subscription.providerSubscriptionId &&
          BILLABLE_SUBSCRIPTION_STATUSES.has(parsed.subscription.status)
        ) {
          // ANY billable subscription of a deleted / pending workspace must be cancelled —
          // also one that is not (or no longer) the stored row (N-12). Durable, retried.
          await this.requestCancellation(
            tx,
            parsed.workspaceId,
            parsed.subscription.providerSubscriptionId,
            'late_webhook',
          );
          cancellationRequested = true;
        }
        return wasApplied;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        // A concurrent delivery of the same event won the insert.
        return recordDuplicate();
      }
      throw error;
    }

    if (applied && parsed.workspaceId) {
      this.entitlements.invalidate(parsed.workspaceId);
    }
    if (cancellationRequested && parsed.workspaceId) {
      // Best effort now; the request is durable and the reconciler retries it (N-3).
      await this.processCancellationRequests({ workspaceId: parsed.workspaceId }).catch(
        (error: unknown) =>
          this.logger.error({
            msg: 'billing.cancellation.process_failed',
            workspaceId: parsed.workspaceId,
            errorName: error instanceof Error ? error.name : 'unknown',
          }),
      );
    }

    this.metrics?.recordBillingWebhook(eventType, 'processed');
    this.metrics?.recordWebhook({
      provider: 'paddle',
      eventType,
      status: 'processed',
      durationSeconds: (Date.now() - startedAt) / 1000,
    });
    this.providerHealth?.recordSignal('paddle', true);

    this.logger.log({
      msg: 'billing.webhook.processed',
      event: 'billing.webhook.processed',
      eventType,
      durationMs: Date.now() - startedAt,
    });

    return { ok: true };
  }

  /**
   * Store a cancellation the provider has just confirmed. `applySubscription` skips updates
   * older than the stored provider timestamp (out-of-order webhooks); a confirmation response
   * can carry an earlier timestamp than a webhook stored moments before (clock skew), so the
   * non-billable status is written even when that ordering check skipped the update.
   */
  private async storeConfirmedCancellation(
    db: Prisma.TransactionClient,
    workspaceId: string,
    remote: NormalizedProviderSubscription,
  ): Promise<void> {
    await this.applySubscription(db, workspaceId, remote);
    await db.workspaceSubscription.updateMany({
      where: {
        workspaceId,
        status: { in: [...BILLABLE_SUBSCRIPTION_STATUSES] },
        ...(remote.providerSubscriptionId
          ? { providerSubscriptionId: remote.providerSubscriptionId }
          : {}),
      },
      data: { status: remote.status, cancelAtPeriodEnd: false },
    });
  }

  private resolvePriceId(planId: Exclude<ProductPlanId, 'free'>, cycle: BillingCycle): string {
    const prices = this.config.get('paddle', { infer: true }).prices;
    if (planId === 'pro') {
      return cycle === 'yearly' ? prices.proYearly : prices.proMonthly;
    }
    return cycle === 'yearly' ? prices.teamYearly : prices.teamMonthly;
  }

  /** Map configured Paddle price ids to the plan and cycle they sell. */
  private planForPrices(priceIds: string[]): PaidPlan | null {
    const prices = this.config.get('paddle', { infer: true }).prices;
    const table: Array<[string, PaidPlan]> = [
      [prices.proMonthly, { planId: 'pro', billingCycle: 'monthly' }],
      [prices.proYearly, { planId: 'pro', billingCycle: 'yearly' }],
      [prices.teamMonthly, { planId: 'team', billingCycle: 'monthly' }],
      [prices.teamYearly, { planId: 'team', billingCycle: 'yearly' }],
    ];
    for (const priceId of priceIds) {
      const hit = table.find(([configured]) => configured && configured === priceId);
      if (hit) return hit[1];
    }
    return null;
  }

  /**
   * Apply provider state to the workspace row. Returns false when nothing was applied:
   * the update is older than what is stored (Paddle does not guarantee webhook order), or the
   * subscription may not become this workspace's subscription.
   *
   * Which subscription may be applied to a workspace (F-02, F-23, F-34):
   * 1. The one the row already holds — always (ordered by the provider timestamp).
   * 2. A different one only if it is BOUND to the workspace: it carries the id of a checkout
   *    this server created for this workspace (`origin.checkoutId`), or an earlier event
   *    already recorded it on such a checkout. `custom_data.workspaceId` alone proves nothing —
   *    anyone can open a provider checkout naming any workspace.
   * 3. A bound, different subscription never replaces one that is still billable: the stored
   *    subscription stays, and the newcomer is recorded on its checkout row (`conflict`) so it
   *    is visible and is cancelled when the workspace is deleted. It takes over only once the
   *    stored one is no longer billable. This also stops a late event of an old subscription
   *    from pushing out the current one.
   */
  private async applySubscription(
    db: Prisma.TransactionClient,
    workspaceId: string,
    remote: NormalizedProviderSubscription,
    origin: { checkoutId?: string } = {},
  ): Promise<boolean> {
    const existing = await db.workspaceSubscription.findUnique({ where: { workspaceId } });
    const incomingAt = parseProviderTime(remote.providerUpdatedAt);
    const sameSubscription =
      existing?.providerSubscriptionId != null &&
      existing.providerSubscriptionId === remote.providerSubscriptionId;
    const otherSubscription =
      existing?.providerSubscriptionId != null &&
      remote.providerSubscriptionId != null &&
      existing.providerSubscriptionId !== remote.providerSubscriptionId;

    let binding: { id: string; status: string; subscriptionStatus?: string | null } | null = null;
    if (!sameSubscription) {
      binding = await this.findCheckoutBinding(db, workspaceId, remote, origin.checkoutId);
      // A subscription this workspace already saw END (cancelled / expired are terminal at the
      // provider) cannot come back as billable: such an event is a late or retried delivery
      // of an old state. Timestamps of different subscriptions are not comparable, so without
      // this a stale `active` of a finished subscription would restore a paid plan.
      if (
        binding?.subscriptionStatus != null &&
        !BILLABLE_SUBSCRIPTION_STATUSES.has(binding.subscriptionStatus) &&
        BILLABLE_SUBSCRIPTION_STATUSES.has(remote.status)
      ) {
        this.logger.log({
          msg: 'billing.subscription.stale_event_of_ended_subscription_ignored',
          workspaceId,
        });
        return false;
      }
      if (!binding) {
        this.logger.error({
          msg: 'billing.subscription.unbound_ignored',
          workspaceId,
          status: remote.status,
        });
        this.recordBillingAudit('billing.subscription.unbound', workspaceId, remote.status);
        return false;
      }
      if (otherSubscription && BILLABLE_SUBSCRIPTION_STATUSES.has(existing!.status)) {
        await db.billingCheckout.update({
          where: { id: binding.id },
          data: {
            providerSubscriptionId: remote.providerSubscriptionId,
            subscriptionStatus: remote.status,
            // A finished checkout keeps its status; a new one is a second, competing subscription.
            ...(binding.status === 'pending' && BILLABLE_SUBSCRIPTION_STATUSES.has(remote.status)
              ? { status: 'conflict' }
              : {}),
          },
        });
        this.logger.error({
          msg: 'billing.subscription.conflicting_subscription_ignored',
          workspaceId,
          status: remote.status,
        });
        if (BILLABLE_SUBSCRIPTION_STATUSES.has(remote.status)) {
          this.recordBillingAudit('billing.subscription.conflict', workspaceId, remote.status);
        }
        return false;
      }
      if (otherSubscription && !BILLABLE_SUBSCRIPTION_STATUSES.has(remote.status)) {
        // A non-billable state of another subscription has nothing to give this workspace.
        await db.billingCheckout.update({
          where: { id: binding.id },
          data: {
            providerSubscriptionId: remote.providerSubscriptionId,
            subscriptionStatus: remote.status,
          },
        });
        this.logger.log({
          msg: 'billing.subscription.other_subscription_update_ignored',
          workspaceId,
        });
        return false;
      }
    }
    if (
      sameSubscription &&
      existing?.providerUpdatedAt &&
      incomingAt &&
      incomingAt < existing.providerUpdatedAt
    ) {
      this.logger.log({
        msg: 'billing.subscription.stale_update_ignored',
        workspaceId,
        incomingAt: incomingAt.toISOString(),
        storedAt: existing.providerUpdatedAt.toISOString(),
      });
      return false;
    }

    const paid = this.planForPrices(remote.priceIds);
    const planId =
      paid?.planId ??
      (this.config.get('nodeEnv', { infer: true }) !== 'production'
        ? remote.legacyPlanId
        : undefined) ??
      // The subscription we already know keeps its plan when the provider state carries no
      // price (pull paths) or is no longer billable (a cancellation of a subscription whose
      // price id was since retired must still be applied, not fail forever).
      (sameSubscription &&
      (remote.priceIds.length === 0 || !BILLABLE_SUBSCRIPTION_STATUSES.has(remote.status))
        ? existing.planId
        : undefined);
    if (!planId) {
      this.logger.error({
        msg: 'billing.subscription.unknown_price',
        workspaceId,
        priceIds: remote.priceIds,
      });
      // 5xx so Paddle retries once the price is configured; nothing is persisted.
      throw workspaceException(
        'BILLING_RECONCILIATION_REQUIRED',
        'Subscription price does not match any configured plan.',
      );
    }
    const billingCycle = paid?.billingCycle ?? remote.billingCycle;

    const fields = {
      planId,
      status: remote.status,
      billingCycle,
      providerCustomerId: remote.providerCustomerId,
      providerSubscriptionId: remote.providerSubscriptionId,
      currentPeriodStart: remote.currentPeriodStart
        ? new Date(remote.currentPeriodStart)
        : undefined,
      currentPeriodEnd: remote.currentPeriodEnd ? new Date(remote.currentPeriodEnd) : undefined,
      cancelAtPeriodEnd: remote.cancelAtPeriodEnd ?? false,
      // A different subscription starts its own timeline: never inherit the old timestamp.
      providerUpdatedAt: incomingAt ?? (sameSubscription ? undefined : null),
    };
    await db.workspaceSubscription.upsert({
      where: { workspaceId },
      create: { workspaceId, provider: 'paddle', ...fields },
      update: fields,
    });
    if (binding) {
      await db.billingCheckout.update({
        where: { id: binding.id },
        data: {
          providerSubscriptionId: remote.providerSubscriptionId,
          subscriptionStatus: remote.status,
          status: 'completed',
        },
      });
    } else if (remote.providerSubscriptionId) {
      await db.billingCheckout.updateMany({
        where: { workspaceId, providerSubscriptionId: remote.providerSubscriptionId },
        data: { subscriptionStatus: remote.status },
      });
    }
    return true;
  }

  /**
   * The checkout of THIS workspace that authorizes `remote`: the one whose id the event
   * carries, or the one an earlier event of the same subscription was recorded on. One
   * checkout binds one subscription — an id already tied to another subscription is refused.
   */
  private async findCheckoutBinding(
    db: Prisma.TransactionClient,
    workspaceId: string,
    remote: NormalizedProviderSubscription,
    checkoutId: string | undefined,
  ): Promise<{ id: string; status: string; subscriptionStatus?: string | null } | null> {
    if (remote.providerSubscriptionId) {
      const recorded = await db.billingCheckout.findUnique({
        where: { providerSubscriptionId: remote.providerSubscriptionId },
        select: { id: true, status: true, workspaceId: true, subscriptionStatus: true },
      });
      if (recorded) {
        return recorded.workspaceId === workspaceId ? recorded : null;
      }
    }
    if (!checkoutId) return null;
    const checkout = await db.billingCheckout.findFirst({
      where: { id: checkoutId, workspaceId },
      select: { id: true, status: true, providerSubscriptionId: true },
    });
    if (!checkout) return null;
    if (
      checkout.providerSubscriptionId &&
      checkout.providerSubscriptionId !== remote.providerSubscriptionId
    ) {
      return null;
    }
    return checkout;
  }

  private recordBillingAudit(
    type: 'billing.subscription.unbound' | 'billing.subscription.conflict',
    workspaceId: string,
    status: string,
  ): void {
    try {
      this.audit?.record({
        type,
        outcome: 'blocked',
        workspaceId,
        detail: `status=${status}`,
      });
    } catch {
      // never break billing processing on audit
    }
  }
}

export function cancellationFailed() {
  return workspaceException(
    'BILLING_CANCELLATION_FAILED',
    'The subscription could not be cancelled with the billing provider. The workspace is pending deletion and no longer usable; retry deleting it.',
  );
}
