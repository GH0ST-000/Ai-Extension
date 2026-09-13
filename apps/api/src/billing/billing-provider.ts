import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
  BillingCycle,
  BillingCheckoutResponse,
  ProductPlanId,
  SubscriptionStatus,
} from '@project-x/types';

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
  getPortalLink(providerCustomerId: string, returnUrl: string): Promise<string>;
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

/**
 * Sandbox/dev billing provider — deterministic HMAC verification for tests and local use.
 * Replace with official Paddle SDK adapter when PADDLE_API_KEY is configured.
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

  async getPortalLink(providerCustomerId: string, returnUrl: string): Promise<string> {
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
    const expected = createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');
    const provided = signatureHeader.replace(/^sha256=/, '').trim();
    try {
      return timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
    } catch {
      return false;
    }
  }

  parseWebhook(rawBody: Buffer): {
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
        custom_data?: { workspaceId?: string };
        id?: string;
        customer_id?: string;
        status?: string;
        plan_id?: string;
        billing_cycle?: string;
        current_period_start?: string;
        current_period_end?: string;
        cancel_at_period_end?: boolean;
      };
    };
    const eventId = json.event_id ?? json.eventId;
    const eventType = json.event_type ?? json.eventType;
    if (!eventId || !eventType) {
      throw new Error('Malformed webhook');
    }
    const workspaceId = json.data?.workspace_id ?? json.data?.custom_data?.workspaceId ?? undefined;
    const status = (json.data?.status as SubscriptionStatus | undefined) ?? 'active';
    const planId = (json.data?.plan_id as ProductPlanId | undefined) ?? 'pro';
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
            ...(json.data.current_period_start
              ? { currentPeriodStart: json.data.current_period_start }
              : {}),
            ...(json.data.current_period_end
              ? { currentPeriodEnd: json.data.current_period_end }
              : {}),
            cancelAtPeriodEnd: Boolean(json.data.cancel_at_period_end),
            providerUpdatedAt: json.occurred_at ?? new Date().toISOString(),
          }
        : undefined,
    };
  }
}
