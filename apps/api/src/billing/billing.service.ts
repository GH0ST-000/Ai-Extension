import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getProductPlan, isProductPlanId } from '@project-x/shared';
import type {
  BillingCheckoutResponse,
  BillingCycle,
  BillingPortalResponse,
  CreateBillingCheckoutRequest,
  ProductPlanId,
  WorkspaceBillingView,
} from '@project-x/types';

import type { ApiConfig } from '../config/configuration';
import { EntitlementService } from '../entitlements/entitlements.service';
import { MetricsService } from '../observability/metrics.service';
import { ProviderHealthService } from '../observability/provider-health.service';
import { PrismaService } from '../prisma/prisma.service';
import { UsageService } from '../usage/usage.service';
import { workspaceException } from '../workspaces/workspace.errors';
import {
  createBillingProvider,
  type BillingProvider,
  type NormalizedProviderSubscription,
} from './billing-provider';

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
    const planId = await this.entitlements.getPlanId(workspaceId);
    const entitlements = await this.entitlements.getEntitlements(workspaceId);
    const usage = await this.usage.getUsageCounters(workspaceId);
    const seatsUsed = await this.prisma.workspaceMembership.count({
      where: { workspaceId, status: 'active' },
    });
    const paddle = this.config.get('paddle', { infer: true });
    const row = await this.prisma.workspaceSubscription.findUnique({ where: { workspaceId } });
    const plan = getProductPlan(planId);

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
    };
  }

  async createCheckout(
    workspaceId: string,
    userEmail: string,
    input: CreateBillingCheckoutRequest,
  ): Promise<BillingCheckoutResponse> {
    const paddle = this.config.get('paddle', { infer: true });
    const priceId = this.resolvePriceId(input.planId, input.billingCycle);
    if (!priceId && paddle.environment === 'production') {
      throw workspaceException('BILLING_CONFIGURATION_INVALID', 'Billing price is not configured.');
    }
    const appBaseUrl = this.config.get('appBaseUrl', { infer: true });
    try {
      const result = await this.provider.createCheckout({
        workspaceId,
        planId: input.planId,
        billingCycle: input.billingCycle,
        customerEmail: userEmail,
        priceId: priceId || `sandbox_${input.planId}_${input.billingCycle}`,
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
      await this.applySubscription(workspaceId, normalized);
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
      await this.applySubscription(workspaceId, remote);
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

    const existing = await this.prisma.billingWebhookEvent.findUnique({
      where: {
        provider_eventId: {
          provider: 'paddle',
          eventId: parsed.eventId,
        },
      },
    });
    if (existing) {
      this.metrics?.recordBillingWebhook(eventType, 'duplicate');
      this.metrics?.recordWebhook({
        provider: 'paddle',
        eventType,
        status: 'duplicate',
        durationSeconds: (Date.now() - startedAt) / 1000,
      });
      return { ok: true };
    }

    await this.prisma.billingWebhookEvent.create({
      data: {
        provider: 'paddle',
        eventId: parsed.eventId,
        eventType: parsed.eventType,
        payloadJson: {
          eventType: parsed.eventType,
          workspaceId: parsed.workspaceId ?? null,
          planId: parsed.subscription?.planId ?? null,
          status: parsed.subscription?.status ?? null,
        },
      },
    });

    if (parsed.workspaceId && parsed.subscription) {
      await this.applySubscription(parsed.workspaceId, parsed.subscription);
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

  private async applySubscription(
    workspaceId: string,
    remote: NormalizedProviderSubscription,
  ): Promise<void> {
    const planId = isProductPlanId(remote.planId) ? remote.planId : 'free';
    await this.prisma.workspaceSubscription.upsert({
      where: { workspaceId },
      create: {
        workspaceId,
        provider: 'paddle',
        planId,
        status: remote.status,
        billingCycle: remote.billingCycle,
        providerCustomerId: remote.providerCustomerId,
        providerSubscriptionId: remote.providerSubscriptionId,
        currentPeriodStart: remote.currentPeriodStart
          ? new Date(remote.currentPeriodStart)
          : undefined,
        currentPeriodEnd: remote.currentPeriodEnd ? new Date(remote.currentPeriodEnd) : undefined,
        cancelAtPeriodEnd: remote.cancelAtPeriodEnd ?? false,
      },
      update: {
        planId,
        status: remote.status,
        billingCycle: remote.billingCycle,
        providerCustomerId: remote.providerCustomerId,
        providerSubscriptionId: remote.providerSubscriptionId,
        currentPeriodStart: remote.currentPeriodStart
          ? new Date(remote.currentPeriodStart)
          : undefined,
        currentPeriodEnd: remote.currentPeriodEnd ? new Date(remote.currentPeriodEnd) : undefined,
        cancelAtPeriodEnd: remote.cancelAtPeriodEnd ?? false,
      },
    });
  }
}
