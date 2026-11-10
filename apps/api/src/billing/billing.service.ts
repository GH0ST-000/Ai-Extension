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

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<ApiConfig, true>,
    private readonly entitlements: EntitlementService,
    private readonly usage: UsageService,
    @Optional() private readonly metrics?: MetricsService,
    @Optional() private readonly providerHealth?: ProviderHealthService,
  ) {
    this.provider = createBillingProvider({
      nodeEnv: this.config.get('nodeEnv', { infer: true }),
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

    const appBaseUrl = this.config.get('appBaseUrl', { infer: true });
    try {
      const result = await this.provider.createCheckout({
        workspaceId,
        planId: input.planId,
        billingCycle: input.billingCycle,
        customerEmail: userEmail,
        priceId: resolvedPriceId,
        successUrl: `${appBaseUrl}/app/billing`,
      });
      this.metrics?.recordBillingCheckout('success');
      return result;
    } catch (error) {
      this.metrics?.recordBillingCheckout('failure');
      this.logger.warn({
        msg: 'billing.checkout.failed',
        error: error instanceof Error ? error.message : 'unknown',
      });
      throw workspaceException('BILLING_CHECKOUT_FAILED', 'Unable to start checkout.');
    }
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
    await this.applySubscription(this.prisma, workspaceId, updated);
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
    const paddle = this.config.get('paddle', { infer: true });
    const appBaseUrl = this.config.get('appBaseUrl', { infer: true });
    const url = await this.provider.getPortalLink(
      row.providerCustomerId,
      `${appBaseUrl}/app/billing`,
      row.providerSubscriptionId ?? undefined,
    );
    if (
      !url.startsWith('https://') &&
      !(url.startsWith('http://') && paddle.environment === 'sandbox')
    ) {
      throw workspaceException('BILLING_PROVIDER_UNAVAILABLE', 'Invalid portal URL.');
    }
    // Prefer Paddle-hosted portal domains when a full URL is returned.
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      const allowed =
        host === 'localhost' ||
        host.endsWith('.paddle.com') ||
        host.endsWith('.paddle.io') ||
        host === 'sandbox-api.paddle.com' ||
        host === 'api.paddle.com';
      if (!allowed && paddle.environment === 'production') {
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
      await this.applySubscription(this.prisma, workspaceId, normalized);
    }
    this.entitlements.invalidate(workspaceId);
    return this.getBillingView(workspaceId);
  }

  async refresh(workspaceId: string): Promise<WorkspaceBillingView> {
    const row = await this.prisma.workspaceSubscription.findUnique({ where: { workspaceId } });
    if (!row?.providerSubscriptionId) {
      return this.getBillingView(workspaceId);
    }
    const remote = await this.provider.getSubscription(row.providerSubscriptionId);
    if (remote) {
      await this.applySubscription(this.prisma, workspaceId, remote);
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
        return this.applySubscription(tx, parsed.workspaceId, parsed.subscription);
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
   * Apply provider state to the workspace row. Returns false when the update is older
   * than what is already stored (Paddle does not guarantee webhook order).
   */
  private async applySubscription(
    db: Prisma.TransactionClient,
    workspaceId: string,
    remote: NormalizedProviderSubscription,
  ): Promise<boolean> {
    const existing = await db.workspaceSubscription.findUnique({ where: { workspaceId } });
    const incomingAt = parseProviderTime(remote.providerUpdatedAt);
    if (existing?.providerUpdatedAt && incomingAt && incomingAt < existing.providerUpdatedAt) {
      this.logger.log({
        msg: 'billing.subscription.stale_update_ignored',
        workspaceId,
        incomingAt: incomingAt.toISOString(),
        storedAt: existing.providerUpdatedAt.toISOString(),
      });
      return false;
    }

    const paid = this.planForPrices(remote.priceIds);
    const sameSubscription =
      existing?.providerSubscriptionId != null &&
      existing.providerSubscriptionId === remote.providerSubscriptionId;
    const planId =
      paid?.planId ??
      (this.config.get('nodeEnv', { infer: true }) !== 'production'
        ? remote.legacyPlanId
        : undefined) ??
      // Pull paths (cancel/refresh) on a subscription we already know keep its plan.
      (sameSubscription && remote.priceIds.length === 0 ? existing.planId : undefined);
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
      ...(incomingAt ? { providerUpdatedAt: incomingAt } : {}),
    };
    await db.workspaceSubscription.upsert({
      where: { workspaceId },
      create: { workspaceId, provider: 'paddle', ...fields },
      update: fields,
    });
    return true;
  }
}
