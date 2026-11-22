import { createHmac } from 'node:crypto';

import { HttpException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BillingService } from './billing.service';
import { SandboxBillingProvider } from './billing-provider';

describe('SandboxBillingProvider', () => {
  it('verifies HMAC signatures over the raw body', () => {
    const provider = new SandboxBillingProvider('test-secret');
    const body = Buffer.from(
      JSON.stringify({ event_id: 'evt_1', event_type: 'subscription.updated' }),
    );
    const signature = createHmac('sha256', 'test-secret').update(body).digest('hex');
    expect(provider.verifyWebhook(body, signature)).toBe(true);
    expect(provider.verifyWebhook(body, 'sha256=' + signature)).toBe(true);
    expect(provider.verifyWebhook(body, 'deadbeef')).toBe(false);
    expect(provider.verifyWebhook(body, undefined)).toBe(false);
  });
});

/** A checkout the server created for ws_1 (custom_data.checkoutId of its subscription). */
const CHECKOUT_ID = `chk_${'a'.repeat(32)}`;

describe('BillingService.handleWebhook', () => {
  const prisma = {
    billingWebhookEvent: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    workspaceSubscription: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
    },
    // F-02: the checkouts this server created. The double evaluates `where` (id + workspace),
    // so a webhook is only bound when it names a checkout of the SAME workspace.
    billingCheckout: {
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async (args: { where: { id?: string; workspaceId?: string } }) =>
        args.where.id === CHECKOUT_ID && args.where.workspaceId === 'ws_1'
          ? {
              id: CHECKOUT_ID,
              status: 'pending',
              providerSubscriptionId: null,
              createdAt: new Date(0),
            }
          : null,
      ),
      create: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 0 })),
      deleteMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => []),
    },
    $transaction: vi.fn(),
    // The webhook transaction takes the workspace row lock (N-12); an active workspace.
    $queryRaw: vi.fn(async () => [{ status: 'active' }]),
    workspace: {
      findUnique: vi.fn(async () => ({ status: 'active' })),
    },
    workspaceMembership: {
      count: vi.fn(),
    },
  };

  const config = {
    get: vi.fn((key: string) => {
      if (key === 'nodeEnv') return 'test';
      if (key === 'paddle') {
        return {
          apiKey: '',
          webhookSecret: 'test-secret',
          clientToken: '',
          environment: 'sandbox',
          prices: {
            proMonthly: 'pri_pro_m',
            proYearly: 'pri_pro_y',
            teamMonthly: 'pri_team_m',
            teamYearly: 'pri_team_y',
          },
        };
      }
      if (key === 'appBaseUrl') return 'http://localhost:3000';
      return undefined;
    }),
  };

  const entitlements = {
    getPlanId: vi.fn().mockResolvedValue('free'),
    getEntitlements: vi.fn().mockResolvedValue({ maxWorkspaceMembers: 1 }),
    invalidate: vi.fn(),
  };

  const usage = {
    getUsageCounters: vi.fn().mockResolvedValue([]),
  };

  let service: BillingService;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));
    prisma.billingWebhookEvent.findUnique.mockResolvedValue(null);
    prisma.billingWebhookEvent.create.mockResolvedValue({});
    prisma.workspaceSubscription.upsert.mockResolvedValue({});
    prisma.workspaceSubscription.findUnique.mockResolvedValue(null);
    prisma.workspaceMembership.count.mockResolvedValue(1);
    service = new BillingService(
      prisma as never,
      config as never,
      entitlements as never,
      usage as never,
    );
  });

  /**
   * Signs a Paddle payload. Like a real subscription that came out of a server-created
   * checkout, it carries that checkout's id in custom_data unless `bound: false`.
   */
  function signedBody(
    payload: Record<string, unknown>,
    options: { bound?: boolean } = {},
  ): { raw: Buffer; signature: string } {
    const data = payload.data as Record<string, unknown> | undefined;
    if (data && options.bound !== false) {
      data.custom_data = {
        ...((data.custom_data as Record<string, unknown> | undefined) ?? {}),
        checkoutId: CHECKOUT_ID,
      };
    }
    const raw = Buffer.from(JSON.stringify(payload));
    const signature = createHmac('sha256', 'test-secret').update(raw).digest('hex');
    return { raw, signature };
  }

  it('rejects invalid signatures without mutating state', async () => {
    const { raw } = signedBody({
      event_id: 'evt_bad',
      event_type: 'subscription.updated',
      data: { workspace_id: 'ws_1', plan_id: 'pro', status: 'active' },
    });

    await expect(service.handleWebhook(raw, 'invalid')).rejects.toBeInstanceOf(HttpException);
    try {
      await service.handleWebhook(raw, 'invalid');
    } catch (err) {
      const body = (err as HttpException).getResponse() as { code?: string };
      expect(body.code).toBe('BILLING_WEBHOOK_INVALID');
    }
    expect(prisma.billingWebhookEvent.create).not.toHaveBeenCalled();
    expect(prisma.workspaceSubscription.upsert).not.toHaveBeenCalled();
  });

  it('applies subscription updates for a valid signed event', async () => {
    const { raw, signature } = signedBody({
      event_id: 'evt_good',
      event_type: 'subscription.updated',
      data: {
        workspace_id: 'ws_1',
        id: 'sub_1',
        customer_id: 'ctm_1',
        plan_id: 'pro',
        status: 'active',
        billing_cycle: 'monthly',
      },
    });

    await expect(service.handleWebhook(raw, signature)).resolves.toEqual({ ok: true });
    expect(prisma.billingWebhookEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          provider: 'paddle',
          eventId: 'evt_good',
        }),
      }),
    );
    expect(prisma.workspaceSubscription.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: 'ws_1' },
        create: expect.objectContaining({ planId: 'pro', status: 'active' }),
      }),
    );
    expect(entitlements.invalidate).toHaveBeenCalledWith('ws_1');
  });

  it('is idempotent for duplicate eventId', async () => {
    prisma.billingWebhookEvent.findUnique.mockResolvedValue({
      id: 'already',
      eventId: 'evt_dup',
    });
    const { raw, signature } = signedBody({
      event_id: 'evt_dup',
      event_type: 'subscription.updated',
      data: {
        workspace_id: 'ws_1',
        plan_id: 'pro',
        status: 'active',
      },
    });

    await expect(service.handleWebhook(raw, signature)).resolves.toEqual({ ok: true });
    expect(prisma.billingWebhookEvent.create).not.toHaveBeenCalled();
    expect(prisma.workspaceSubscription.upsert).not.toHaveBeenCalled();
  });

  function paddleSubscription(
    eventId: string,
    data: Record<string, unknown>,
    eventType = 'subscription.updated',
  ): Record<string, unknown> {
    return {
      event_id: eventId,
      event_type: eventType,
      occurred_at: '2026-11-01T10:00:00Z',
      data: {
        id: 'sub_1',
        customer_id: 'ctm_1',
        status: 'active',
        custom_data: { workspaceId: 'ws_1' },
        billing_cycle: { interval: 'year', frequency: 1 },
        updated_at: '2026-11-01T10:00:00Z',
        ...data,
      },
    };
  }

  it('resolves the plan from the Paddle price id (team is not downgraded to pro)', async () => {
    const { raw, signature } = signedBody(
      paddleSubscription('evt_team', { items: [{ price: { id: 'pri_team_y' } }] }),
    );

    await service.handleWebhook(raw, signature);
    expect(prisma.workspaceSubscription.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ planId: 'team', billingCycle: 'yearly' }),
      }),
    );
  });

  it('maps Paddle "canceled" to cancelled', async () => {
    const { raw, signature } = signedBody(
      paddleSubscription('evt_cancel', {
        status: 'canceled',
        items: [{ price: { id: 'pri_pro_m' } }],
      }),
    );

    await service.handleWebhook(raw, signature);
    expect(prisma.workspaceSubscription.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: expect.objectContaining({ status: 'cancelled' }) }),
    );
  });

  it('records transaction events without touching the subscription', async () => {
    const { raw, signature } = signedBody({
      event_id: 'evt_txn',
      event_type: 'transaction.created',
      data: { id: 'txn_1', status: 'draft', custom_data: { workspaceId: 'ws_1' } },
    });

    await expect(service.handleWebhook(raw, signature)).resolves.toEqual({ ok: true });
    expect(prisma.billingWebhookEvent.create).toHaveBeenCalled();
    expect(prisma.workspaceSubscription.upsert).not.toHaveBeenCalled();
    expect(entitlements.invalidate).not.toHaveBeenCalled();
  });

  it('rejects an unknown price so Paddle retries, instead of guessing a plan', async () => {
    const { raw, signature } = signedBody(
      paddleSubscription('evt_unknown', { items: [{ price: { id: 'pri_other' } }] }),
    );

    await expect(service.handleWebhook(raw, signature)).rejects.toBeInstanceOf(HttpException);
    expect(prisma.workspaceSubscription.upsert).not.toHaveBeenCalled();
  });

  it('propagates apply failures so the event is not acked as processed', async () => {
    prisma.workspaceSubscription.upsert.mockRejectedValueOnce(new Error('db down'));
    const { raw, signature } = signedBody(
      paddleSubscription('evt_fail', { items: [{ price: { id: 'pri_pro_m' } }] }),
    );

    await expect(service.handleWebhook(raw, signature)).rejects.toThrow('db down');
    // Event create and upsert ran inside the same $transaction, so both roll back.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('acks a concurrent duplicate delivery that loses the unique insert', async () => {
    prisma.$transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'test' }),
    );
    const { raw, signature } = signedBody(
      paddleSubscription('evt_race', { items: [{ price: { id: 'pri_pro_m' } }] }),
    );

    await expect(service.handleWebhook(raw, signature)).resolves.toEqual({ ok: true });
    expect(entitlements.invalidate).not.toHaveBeenCalled();
  });

  it('ignores an out-of-order event older than the stored state', async () => {
    prisma.workspaceSubscription.findUnique.mockResolvedValue({
      workspaceId: 'ws_1',
      planId: 'pro',
      status: 'cancelled',
      providerSubscriptionId: 'sub_1',
      providerUpdatedAt: new Date('2026-11-02T00:00:00Z'),
    });
    const { raw, signature } = signedBody(
      paddleSubscription('evt_old', {
        status: 'active',
        items: [{ price: { id: 'pri_pro_m' } }],
        updated_at: '2026-11-01T00:00:00Z',
      }),
    );

    await expect(service.handleWebhook(raw, signature)).resolves.toEqual({ ok: true });
    expect(prisma.workspaceSubscription.upsert).not.toHaveBeenCalled();
    expect(entitlements.invalidate).not.toHaveBeenCalled();
  });

  // ── F-02 / F-23 / F-34: which subscription may be applied to a workspace ──

  it('[F-02] ignores a subscription that names the workspace without one of its checkouts', async () => {
    for (const custom of [
      { workspaceId: 'ws_1' },
      { workspaceId: 'ws_1', checkoutId: `chk_${'b'.repeat(32)}` }, // a checkout id of nobody
      { workspaceId: 'ws_1', checkoutId: 'not-a-checkout-id' },
    ]) {
      const { raw, signature } = signedBody(
        paddleSubscription(`evt_unbound_${JSON.stringify(custom).length}`, {
          id: 'sub_attacker',
          customer_id: 'ctm_attacker',
          custom_data: custom,
          items: [{ price: { id: 'pri_pro_m' } }],
        }),
        { bound: false },
      );
      await expect(service.handleWebhook(raw, signature)).resolves.toEqual({ ok: true });
    }
    expect(prisma.workspaceSubscription.upsert).not.toHaveBeenCalled();
    expect(entitlements.invalidate).not.toHaveBeenCalled();
  });

  it('[F-02] a checkout id of ANOTHER workspace does not bind', async () => {
    const { raw, signature } = signedBody(
      paddleSubscription('evt_cross', {
        id: 'sub_x',
        custom_data: { workspaceId: 'ws_2', checkoutId: CHECKOUT_ID },
        items: [{ price: { id: 'pri_team_m' } }],
      }),
      { bound: false },
    );
    await service.handleWebhook(raw, signature);
    expect(prisma.workspaceSubscription.upsert).not.toHaveBeenCalled();
  });

  it('[F-23] a bound second subscription never replaces one that is still billable', async () => {
    prisma.workspaceSubscription.findUnique.mockResolvedValue({
      workspaceId: 'ws_1',
      planId: 'team',
      status: 'active',
      providerSubscriptionId: 'sub_1',
      providerCustomerId: 'ctm_1',
      providerUpdatedAt: new Date('2026-11-01T10:00:00Z'),
    });
    const { raw, signature } = signedBody(
      paddleSubscription('evt_second', {
        id: 'sub_2',
        customer_id: 'ctm_2',
        updated_at: '2026-11-05T10:00:00Z',
        items: [{ price: { id: 'pri_pro_m' } }],
      }),
    );
    await service.handleWebhook(raw, signature);
    expect(prisma.workspaceSubscription.upsert).not.toHaveBeenCalled();
    // …and it is recorded on its checkout as a conflict (tracked, cancellable on deletion).
    expect(prisma.billingCheckout.update).toHaveBeenCalledWith({
      where: { id: CHECKOUT_ID },
      data: { providerSubscriptionId: 'sub_2', subscriptionStatus: 'active', status: 'conflict' },
    });
  });

  it('[F-23] it takes over once the stored subscription is no longer billable', async () => {
    prisma.workspaceSubscription.findUnique.mockResolvedValue({
      workspaceId: 'ws_1',
      planId: 'team',
      status: 'cancelled',
      providerSubscriptionId: 'sub_1',
      providerUpdatedAt: new Date('2026-11-09T10:00:00Z'),
    });
    const { raw, signature } = signedBody(
      paddleSubscription('evt_takeover', {
        id: 'sub_2',
        // Older than the stored timestamp of sub_1: timestamps of different subscriptions are
        // not comparable and must not block the takeover.
        updated_at: '2026-11-05T10:00:00Z',
        items: [{ price: { id: 'pri_pro_m' } }],
      }),
    );
    await service.handleWebhook(raw, signature);
    expect(prisma.workspaceSubscription.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ providerSubscriptionId: 'sub_2', planId: 'pro' }),
      }),
    );
    expect(prisma.billingCheckout.update).toHaveBeenCalledWith({
      where: { id: CHECKOUT_ID },
      data: { providerSubscriptionId: 'sub_2', subscriptionStatus: 'active', status: 'completed' },
    });
  });

  it('[F-34] a late event of an OLD subscription cannot push out the current one', async () => {
    prisma.workspaceSubscription.findUnique.mockResolvedValue({
      workspaceId: 'ws_1',
      planId: 'pro',
      status: 'active',
      providerSubscriptionId: 'sub_new',
      providerUpdatedAt: new Date('2026-11-10T10:00:00Z'),
    });
    // sub_old was this workspace's subscription once (recorded on its checkout).
    prisma.billingCheckout.findUnique.mockResolvedValueOnce({
      id: 'chk_old',
      status: 'completed',
      workspaceId: 'ws_1',
    } as never);
    const { raw, signature } = signedBody(
      paddleSubscription('evt_late_old', {
        id: 'sub_old',
        status: 'active',
        items: [{ price: { id: 'pri_team_m' } }],
      }),
      { bound: false },
    );
    await service.handleWebhook(raw, signature);
    expect(prisma.workspaceSubscription.upsert).not.toHaveBeenCalled();
    // A completed checkout is not relabelled a conflict by a stale event.
    expect(prisma.billingCheckout.update).toHaveBeenCalledWith({
      where: { id: 'chk_old' },
      data: { providerSubscriptionId: 'sub_old', subscriptionStatus: 'active' },
    });
  });

  it('a cancellation of the known subscription is applied even if its price id was retired', async () => {
    prisma.workspaceSubscription.findUnique.mockResolvedValue({
      workspaceId: 'ws_1',
      planId: 'pro',
      status: 'active',
      providerSubscriptionId: 'sub_1',
      providerUpdatedAt: new Date('2026-10-01T10:00:00Z'),
    });
    const { raw, signature } = signedBody(
      paddleSubscription(
        'evt_cancel_retired_price',
        { status: 'canceled', items: [{ price: { id: 'pri_retired' } }] },
        'subscription.canceled',
      ),
      { bound: false },
    );
    await expect(service.handleWebhook(raw, signature)).resolves.toEqual({ ok: true });
    expect(prisma.workspaceSubscription.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ status: 'cancelled', planId: 'pro' }),
      }),
    );
  });

  describe('createCheckout', () => {
    function provider() {
      return (service as unknown as { provider: Record<string, (...args: unknown[]) => unknown> })
        .provider;
    }

    it('switches an existing paid subscription in place instead of opening a checkout', async () => {
      prisma.workspaceSubscription.findUnique.mockResolvedValue({
        workspaceId: 'ws_1',
        planId: 'pro',
        status: 'active',
        billingCycle: 'monthly',
        providerSubscriptionId: 'sub_1',
        providerUpdatedAt: null,
      });
      const change = vi.spyOn(provider(), 'changeSubscriptionPrice');
      const checkout = vi.spyOn(provider(), 'createCheckout');

      const result = await service.createCheckout('ws_1', 'a@b.c', {
        planId: 'team',
        billingCycle: 'monthly',
      });

      expect(result).toMatchObject({ planId: 'team', subscriptionUpdated: true });
      expect(change).toHaveBeenCalledWith('sub_1', 'pri_team_m');
      expect(checkout).not.toHaveBeenCalled();
      expect(prisma.workspaceSubscription.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ update: expect.objectContaining({ planId: 'team' }) }),
      );
      expect(entitlements.invalidate).toHaveBeenCalledWith('ws_1');
    });

    it('rejects switching to the plan and cycle the workspace already has', async () => {
      prisma.workspaceSubscription.findUnique.mockResolvedValue({
        workspaceId: 'ws_1',
        planId: 'pro',
        status: 'active',
        billingCycle: 'monthly',
        providerSubscriptionId: 'sub_1',
      });
      const change = vi.spyOn(provider(), 'changeSubscriptionPrice');

      await expect(
        service.createCheckout('ws_1', 'a@b.c', { planId: 'pro', billingCycle: 'monthly' }),
      ).rejects.toBeInstanceOf(HttpException);
      expect(change).not.toHaveBeenCalled();
    });

    it('opens a checkout when the workspace has no paid subscription', async () => {
      prisma.workspaceSubscription.findUnique.mockResolvedValue({
        workspaceId: 'ws_1',
        planId: 'pro',
        status: 'cancelled',
        providerSubscriptionId: 'sub_old',
      });
      const change = vi.spyOn(provider(), 'changeSubscriptionPrice');

      const result = await service.createCheckout('ws_1', 'a@b.c', {
        planId: 'team',
        billingCycle: 'yearly',
      });

      expect(result.transactionId).toBeDefined();
      expect(result.subscriptionUpdated).toBeUndefined();
      expect(change).not.toHaveBeenCalled();
    });
  });

  it('exposes Paddle list prices per plan and cycle in the billing view', async () => {
    const provider = (service as unknown as { provider: { getPrices: () => unknown } }).provider;
    const getPrices = vi.spyOn(provider, 'getPrices').mockResolvedValue({
      pri_pro_m: { amount: '1900', currencyCode: 'USD' },
      pri_team_y: { amount: '49000', currencyCode: 'USD' },
    } as never);

    const view = await service.getBillingView('ws_1');
    await service.getBillingView('ws_1');

    expect(view.prices).toEqual({
      pro: { monthly: { amount: '1900', currencyCode: 'USD' } },
      team: { yearly: { amount: '49000', currencyCode: 'USD' } },
    });
    expect(getPrices).toHaveBeenCalledTimes(1); // cached
  });

  it('still returns the billing view when prices cannot be fetched', async () => {
    const provider = (service as unknown as { provider: { getPrices: () => unknown } }).provider;
    vi.spyOn(provider, 'getPrices').mockRejectedValue(new Error('paddle down'));

    await expect(service.getBillingView('ws_1')).resolves.toMatchObject({ prices: {} });
  });
});
