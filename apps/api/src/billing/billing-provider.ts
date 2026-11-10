import { createHmac, timingSafeEqual } from 'node:crypto';

import { Environment, Paddle } from '@paddle/paddle-node-sdk';
import type {
  BillingCycle,
  BillingCheckoutResponse,
  BillingPrice,
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
  /** Paddle price ids on the subscription; the plan is resolved from these against config. */
  priceIds: string[];
  /** Explicit plan from a sandbox fixture. Never trusted in production. */
  legacyPlanId?: ProductPlanId;
  status: SubscriptionStatus;
  billingCycle?: BillingCycle;
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
  cancelAtPeriodEnd?: boolean;
  /** Paddle's last-modified time for the entity; used to drop out-of-order events. */
  providerUpdatedAt?: string;
};

const PADDLE_STATUS_MAP: Record<string, SubscriptionStatus> = {
  active: 'active',
  trialing: 'trialing',
  past_due: 'past_due',
  paused: 'paused',
  canceled: 'cancelled',
  cancelled: 'cancelled',
  expired: 'expired',
};

/** Paddle spells it `canceled`; unknown or missing statuses return null (never assume active). */
export function normalizePaddleStatus(raw: unknown): SubscriptionStatus | null {
  return typeof raw === 'string' ? (PADDLE_STATUS_MAP[raw] ?? null) : null;
}

function normalizeInterval(raw: unknown): BillingCycle | undefined {
  if (raw === 'month' || raw === 'monthly') return 'monthly';
  if (raw === 'year' || raw === 'yearly') return 'yearly';
  return undefined;
}

function isPlanId(value: unknown): value is ProductPlanId {
  return value === 'free' || value === 'pro' || value === 'team';
}

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
  /** List prices by id; unknown ids are omitted. */
  getPrices(priceIds: string[]): Promise<Record<string, BillingPrice>>;
  /** Switch an existing subscription to another price, prorating the difference now. */
  changeSubscriptionPrice(
    providerSubscriptionId: string,
    priceId: string,
  ): Promise<NormalizedProviderSubscription>;
  verifyWebhook(rawBody: Buffer, signatureHeader: string | undefined): boolean;
  parseWebhook(rawBody: Buffer): ParsedPaddleWebhook;
}

export type ParsedPaddleWebhook = {
  eventId: string;
  eventType: string;
  occurredAt?: string;
  workspaceId?: string;
  /** Present only for `subscription.*` events — the only events that change billing state. */
  subscription?: NormalizedProviderSubscription;
};

type PaddleWebhookJson = {
  event_id?: string;
  eventId?: string;
  event_type?: string;
  eventType?: string;
  occurred_at?: string;
  data?: {
    workspace_id?: string;
    custom_data?: { workspaceId?: string; workspace_id?: string } | null;
    id?: string;
    customer_id?: string;
    status?: string;
    plan_id?: string;
    items?: Array<{ price?: { id?: string } | null; price_id?: string }>;
    billing_cycle?: { interval?: string } | string | null;
    current_billing_period?: { starts_at?: string; ends_at?: string } | null;
    current_period_start?: string;
    current_period_end?: string;
    cancel_at_period_end?: boolean;
    scheduled_change?: { action?: string } | null;
    updated_at?: string;
  };
};

export function parsePaddleWebhookPayload(rawBody: Buffer): ParsedPaddleWebhook {
  const json = JSON.parse(rawBody.toString('utf8')) as PaddleWebhookJson;
  const eventId = json.event_id ?? json.eventId;
  const eventType = json.event_type ?? json.eventType;
  if (!eventId || !eventType) {
    throw new Error('Malformed webhook');
  }
  const data = json.data;
  const customData = data?.custom_data;
  const workspaceId =
    data?.workspace_id ?? customData?.workspaceId ?? customData?.workspace_id ?? undefined;
  const base = {
    eventId,
    eventType,
    ...(json.occurred_at ? { occurredAt: json.occurred_at } : {}),
    ...(workspaceId ? { workspaceId } : {}),
  };

  // transaction.* / customer.* carry their own ids and statuses (draft, completed, …);
  // applying them as a subscription would clobber the real one.
  if (!eventType.startsWith('subscription.') || !data) {
    return base;
  }

  const status = normalizePaddleStatus(data.status);
  if (!status) {
    throw new Error(`Malformed webhook: unknown subscription status ${String(data.status)}`);
  }
  const priceIds = (data.items ?? [])
    .map((item) => item.price?.id ?? item.price_id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  const rawCycle =
    typeof data.billing_cycle === 'string' ? data.billing_cycle : data.billing_cycle?.interval;
  const billingCycle = normalizeInterval(rawCycle);
  const periodStart = data.current_period_start ?? data.current_billing_period?.starts_at;
  const periodEnd = data.current_period_end ?? data.current_billing_period?.ends_at;
  const providerUpdatedAt = data.updated_at ?? json.occurred_at;

  return {
    ...base,
    subscription: {
      ...(data.customer_id ? { providerCustomerId: data.customer_id } : {}),
      ...(data.id ? { providerSubscriptionId: data.id } : {}),
      priceIds,
      ...(isPlanId(data.plan_id) ? { legacyPlanId: data.plan_id } : {}),
      status,
      ...(billingCycle ? { billingCycle } : {}),
      ...(periodStart ? { currentPeriodStart: periodStart } : {}),
      ...(periodEnd ? { currentPeriodEnd: periodEnd } : {}),
      cancelAtPeriodEnd: Boolean(
        data.cancel_at_period_end ?? data.scheduled_change?.action === 'cancel',
      ),
      ...(providerUpdatedAt ? { providerUpdatedAt } : {}),
    },
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

  // Outside production, real Paddle sandbox credentials talk to the real sandbox API so
  // checkout and webhooks can be tested end to end. Tests always use the fake provider.
  if (nodeEnv !== 'test' && paddle.environment === 'sandbox' && apiKey && webhookSecret) {
    return new PaddleBillingProvider({
      apiKey,
      webhookSecret,
      environment: Environment.sandbox,
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
      priceIds: [],
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
      priceIds: [],
      status: 'active',
      billingCycle: 'monthly',
      providerUpdatedAt: new Date().toISOString(),
    };
  }

  async getPrices(_priceIds: string[]): Promise<Record<string, BillingPrice>> {
    return {};
  }

  async changeSubscriptionPrice(
    providerSubscriptionId: string,
    priceId: string,
  ): Promise<NormalizedProviderSubscription> {
    return {
      providerSubscriptionId,
      priceIds: [priceId],
      status: 'active',
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
      // No per-transaction URL: the dashboard opens the Paddle.js overlay by transaction id,
      // and Paddle falls back to the account's default payment link.
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

  async getPrices(priceIds: string[]): Promise<Record<string, BillingPrice>> {
    const prices = await Promise.all(priceIds.map((id) => this.paddle.prices.get(id)));
    return Object.fromEntries(
      prices.map((price) => [
        price.id,
        { amount: price.unitPrice.amount, currencyCode: price.unitPrice.currencyCode },
      ]),
    );
  }

  async changeSubscriptionPrice(
    providerSubscriptionId: string,
    priceId: string,
  ): Promise<NormalizedProviderSubscription> {
    const subscription = await this.paddle.subscriptions.update(providerSubscriptionId, {
      items: [{ priceId, quantity: 1 }],
      // Charge (or credit) the difference now, and leave the plan unchanged if that fails.
      prorationBillingMode: 'prorated_immediately',
      onPaymentFailure: 'prevent_change',
    });
    return this.normalizeSubscription(subscription);
  }

  private normalizeSubscription(subscription: {
    id: string;
    customerId: string | null;
    status: string;
    items?: Array<{ price?: { id?: string } | null }> | null;
    billingCycle?: { interval?: string } | null;
    currentBillingPeriod?: { startsAt?: string; endsAt?: string } | null;
    scheduledChange?: { action?: string } | null;
    updatedAt?: string | null;
  }): NormalizedProviderSubscription {
    const status = normalizePaddleStatus(subscription.status);
    if (!status) {
      throw new Error(`Unknown Paddle subscription status: ${subscription.status}`);
    }
    const billingCycle = normalizeInterval(subscription.billingCycle?.interval);
    const priceIds = (subscription.items ?? [])
      .map((item) => item.price?.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    return {
      providerSubscriptionId: subscription.id,
      ...(subscription.customerId ? { providerCustomerId: subscription.customerId } : {}),
      priceIds,
      status,
      ...(billingCycle ? { billingCycle } : {}),
      ...(subscription.currentBillingPeriod?.startsAt
        ? { currentPeriodStart: subscription.currentBillingPeriod.startsAt }
        : {}),
      ...(subscription.currentBillingPeriod?.endsAt
        ? { currentPeriodEnd: subscription.currentBillingPeriod.endsAt }
        : {}),
      cancelAtPeriodEnd: subscription.scheduledChange?.action === 'cancel',
      providerUpdatedAt: subscription.updatedAt ?? new Date().toISOString(),
    };
  }
}
