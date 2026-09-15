import { createHmac, timingSafeEqual } from 'node:crypto';

import { Environment, Paddle } from '@paddle/paddle-node-sdk';
import type {
  BillingCycle,
  BillingCheckoutResponse,
  ProductPlanId,
  SubscriptionStatus,
} from '@project-x/types';

import type { ApiConfig } from '../config/configuration';
import {
  buildPaddleWebhookSignatureHeader,
  verifyPaddleWebhookSignature,
} from './paddle-webhook-signature';

export type BillingCheckoutInput = {
  workspaceId: string;
  planId: Exclude<ProductPlanId, 'free'>;
  billingCycle: BillingCycle;
  customerEmail: string;
  priceId: string;
  successUrl: string;
};

export type NormalizedProviderSubscription = {
  providerCustomerId?: string;
  providerSubscriptionId?: string;
  planId: ProductPlanId;
  status: SubscriptionStatus;
  billingCycle?: BillingCycle;
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
  cancelAtPeriodEnd?: boolean;
  providerUpdatedAt?: string;
};

export interface BillingProvider {
  createCheckout(input: BillingCheckoutInput): Promise<BillingCheckoutResponse>;
  getPortalLink(
    providerCustomerId: string,
    returnUrl: string,
    providerSubscriptionId?: string,
  ): Promise<string>;
  cancelSubscription(
    providerSubscriptionId: string,
    atPeriodEnd: boolean,
  ): Promise<NormalizedProviderSubscription>;
  getSubscription(providerSubscriptionId: string): Promise<NormalizedProviderSubscription | null>;
  verifyWebhook(rawBody: Buffer, signatureHeader: string | undefined): boolean;
  parseWebhook(rawBody: Buffer): {
    eventId: string;
    eventType: string;
    occurredAt?: string;
    workspaceId?: string;
    subscription?: NormalizedProviderSubscription;
  };
}

export function parsePaddleWebhookPayload(rawBody: Buffer): {
  eventId: string;
  eventType: string;
  occurredAt?: string;
  workspaceId?: string;
  subscription?: NormalizedProviderSubscription;
} {
  const json = JSON.parse(rawBody.toString('utf8')) as {
    event_id?: string;
    eventId?: string;
    event_type?: string;
    eventType?: string;
    occurred_at?: string;
    data?: {
      workspace_id?: string;
      custom_data?: { workspaceId?: string; workspace_id?: string };
      id?: string;
      customer_id?: string;
      status?: string;
      plan_id?: string;
      billing_cycle?: string;
      current_billing_period?: { starts_at?: string; ends_at?: string };
      current_period_start?: string;
      current_period_end?: string;
      cancel_at_period_end?: boolean;
      scheduled_change?: { action?: string } | null;
    };
  };
  const eventId = json.event_id ?? json.eventId;
  const eventType = json.event_type ?? json.eventType;
  if (!eventId || !eventType) {
    throw new Error('Malformed webhook');
  }
  const customData = json.data?.custom_data;
  const workspaceId =
    json.data?.workspace_id ?? customData?.workspaceId ?? customData?.workspace_id ?? undefined;
  const status = (json.data?.status as SubscriptionStatus | undefined) ?? 'active';
  const planId = (json.data?.plan_id as ProductPlanId | undefined) ?? 'pro';
  const periodStart =
    json.data?.current_period_start ?? json.data?.current_billing_period?.starts_at;
  const periodEnd = json.data?.current_period_end ?? json.data?.current_billing_period?.ends_at;
  return {
    eventId,
    eventType,
    ...(json.occurred_at ? { occurredAt: json.occurred_at } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    subscription: json.data
      ? {
          ...(json.data.customer_id ? { providerCustomerId: json.data.customer_id } : {}),
          ...(json.data.id ? { providerSubscriptionId: json.data.id } : {}),
          planId,
          status,
          ...(json.data.billing_cycle === 'monthly' || json.data.billing_cycle === 'yearly'
            ? { billingCycle: json.data.billing_cycle }
            : {}),
          ...(periodStart ? { currentPeriodStart: periodStart } : {}),
          ...(periodEnd ? { currentPeriodEnd: periodEnd } : {}),
          cancelAtPeriodEnd: Boolean(
            json.data.cancel_at_period_end ?? json.data.scheduled_change?.action === 'cancel',
          ),
          providerUpdatedAt: json.occurred_at ?? new Date().toISOString(),
        }
      : undefined,
  };
}

function verifyLegacySandboxWebhook(
  rawBody: Buffer,
  signatureHeader: string,
  webhookSecret: string,
): boolean {
  const expected = createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  const provided = signatureHeader.replace(/^sha256=/, '').trim();
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
  } catch {
    return false;
  }
}

export type BillingProviderConfig = Pick<ApiConfig, 'nodeEnv' | 'paddle'>;

export function createBillingProvider(config: BillingProviderConfig): BillingProvider {
  const { nodeEnv, paddle } = config;
  const webhookSecret = paddle.webhookSecret?.trim() ?? '';
  const apiKey = paddle.apiKey?.trim() ?? '';

  if (nodeEnv === 'production') {
    if (paddle.environment !== 'production') {
      throw new Error(
        'Sandbox Paddle billing is forbidden in production (set PADDLE_ENVIRONMENT=production).',
      );
    }
    if (!apiKey || !webhookSecret) {
      throw new Error('PADDLE_API_KEY and PADDLE_WEBHOOK_SECRET are required in production.');
    }
    return new PaddleBillingProvider({
      apiKey,
      webhookSecret,
      environment: Environment.production,
    });
  }

  const secret =
    webhookSecret || (nodeEnv === 'test' ? 'test-webhook-secret' : 'dev-webhook-secret');
  return new SandboxBillingProvider(secret);
}

/**
 * Sandbox/dev billing provider — deterministic verification for tests and local use.
 */
export class SandboxBillingProvider implements BillingProvider {
  constructor(private readonly webhookSecret: string) {}

  async createCheckout(input: BillingCheckoutInput): Promise<BillingCheckoutResponse> {
    const transactionId = `txn_sandbox_${input.workspaceId}_${input.planId}`;
    return {
      transactionId,
      checkoutUrl: `${input.successUrl}?sandbox_checkout=${encodeURIComponent(transactionId)}&plan=${input.planId}`,
      planId: input.planId,
      billingCycle: input.billingCycle,
    };
  }

  async getPortalLink(
    providerCustomerId: string,
    returnUrl: string,
    _providerSubscriptionId?: string,
  ): Promise<string> {
    return `${returnUrl}?sandbox_portal=${encodeURIComponent(providerCustomerId)}`;
  }

  async cancelSubscription(
    providerSubscriptionId: string,
    atPeriodEnd: boolean,
  ): Promise<NormalizedProviderSubscription> {
    return {
      providerSubscriptionId,
      planId: 'pro',
      status: atPeriodEnd ? 'cancelled' : 'expired',
      cancelAtPeriodEnd: atPeriodEnd,
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      providerUpdatedAt: new Date().toISOString(),
    };
  }

  async getSubscription(
    providerSubscriptionId: string,
  ): Promise<NormalizedProviderSubscription | null> {
    return {
      providerSubscriptionId,
      providerCustomerId: `ctm_sandbox_${providerSubscriptionId}`,
      planId: 'pro',
      status: 'active',
      billingCycle: 'monthly',
      providerUpdatedAt: new Date().toISOString(),
    };
  }

  verifyWebhook(rawBody: Buffer, signatureHeader: string | undefined): boolean {
    if (!signatureHeader || !this.webhookSecret) return false;
    if (signatureHeader.includes('ts=')) {
      return verifyPaddleWebhookSignature(rawBody, signatureHeader, this.webhookSecret);
    }
    return verifyLegacySandboxWebhook(rawBody, signatureHeader, this.webhookSecret);
  }

  /** Convenience for tests simulating Paddle live webhooks locally. */
  signWebhook(rawBody: Buffer, ts?: number): string {
    return buildPaddleWebhookSignatureHeader(rawBody, this.webhookSecret, { ts });
  }

  parseWebhook(rawBody: Buffer) {
    return parsePaddleWebhookPayload(rawBody);
  }
}

export class PaddleBillingProvider implements BillingProvider {
  private readonly paddle: Paddle;

  constructor(options: {
    apiKey: string;
    webhookSecret: string;
    environment: Environment.production | Environment.sandbox;
  }) {
    this.webhookSecret = options.webhookSecret;
    this.paddle = new Paddle(options.apiKey, { environment: options.environment });
  }

  private readonly webhookSecret: string;

  verifyWebhook(rawBody: Buffer, signatureHeader: string | undefined): boolean {
    return verifyPaddleWebhookSignature(rawBody, signatureHeader, this.webhookSecret);
  }

  parseWebhook(rawBody: Buffer) {
    return parsePaddleWebhookPayload(rawBody);
  }

  async createCheckout(input: BillingCheckoutInput): Promise<BillingCheckoutResponse> {
    const transaction = await this.paddle.transactions.create({
      items: [{ priceId: input.priceId, quantity: 1 }],
      customData: { workspaceId: input.workspaceId },
      checkout: { url: input.successUrl },
    });
    const checkoutUrl = transaction.checkout?.url;
    if (!checkoutUrl) {
      throw new Error('Paddle checkout URL missing from transaction response.');
    }
    return {
      transactionId: transaction.id,
      checkoutUrl,
      planId: input.planId,
      billingCycle: input.billingCycle,
    };
  }

  async getPortalLink(
    providerCustomerId: string,
    _returnUrl: string,
    providerSubscriptionId?: string,
  ): Promise<string> {
    const subscriptionIds = providerSubscriptionId ? [providerSubscriptionId] : [];
    const session = await this.paddle.customerPortalSessions.create(
      providerCustomerId,
      subscriptionIds,
    );
    return session.urls.general.overview;
  }

  async cancelSubscription(
    providerSubscriptionId: string,
    atPeriodEnd: boolean,
  ): Promise<NormalizedProviderSubscription> {
    const subscription = atPeriodEnd
      ? await this.paddle.subscriptions.cancel(providerSubscriptionId, {
          effectiveFrom: 'next_billing_period',
        })
      : await this.paddle.subscriptions.cancel(providerSubscriptionId, {
          effectiveFrom: 'immediately',
        });
    return this.normalizeSubscription(subscription);
  }

  async getSubscription(
    providerSubscriptionId: string,
  ): Promise<NormalizedProviderSubscription | null> {
    try {
      const subscription = await this.paddle.subscriptions.get(providerSubscriptionId);
      return this.normalizeSubscription(subscription);
    } catch {
      return null;
    }
  }

  private normalizeSubscription(subscription: {
    id: string;
    customerId: string | null;
    status: string;
    customData?: { workspaceId?: string } | null;
    billingCycle?: { interval?: string } | null;
    currentBillingPeriod?: { startsAt?: string; endsAt?: string } | null;
    scheduledChange?: { action?: string } | null;
  }): NormalizedProviderSubscription {
    const billingInterval = subscription.billingCycle?.interval;
    const billingCycle: BillingCycle | undefined =
      billingInterval === 'year' ? 'yearly' : billingInterval === 'month' ? 'monthly' : undefined;
    return {
      providerSubscriptionId: subscription.id,
      ...(subscription.customerId ? { providerCustomerId: subscription.customerId } : {}),
      planId: 'pro',
      status: (subscription.status as SubscriptionStatus) ?? 'active',
      ...(billingCycle ? { billingCycle } : {}),
      ...(subscription.currentBillingPeriod?.startsAt
        ? { currentPeriodStart: subscription.currentBillingPeriod.startsAt }
        : {}),
      ...(subscription.currentBillingPeriod?.endsAt
        ? { currentPeriodEnd: subscription.currentBillingPeriod.endsAt }
        : {}),
      cancelAtPeriodEnd: subscription.scheduledChange?.action === 'cancel',
      providerUpdatedAt: new Date().toISOString(),
    };
  }
}
