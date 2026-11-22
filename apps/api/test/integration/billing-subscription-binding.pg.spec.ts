/**
 * F-02 / F-03 / F-23 / F-34 — subscription ownership and cancellation recovery, against real
 * PostgreSQL. Real: BillingService (checkout records, webhook processing, cancellation
 * requests), EntitlementService, WorkspaceDeletionService, the Paddle webhook signature.
 * The provider is the sandbox provider with its network-shaped methods replaced by a small
 * Paddle model (no network, no real Paddle call).
 */
import { createHmac } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { BillingService } from '../../src/billing/billing.service';
import { EntitlementService } from '../../src/entitlements/entitlements.service';
import { UsageService } from '../../src/usage/usage.service';
import { WorkspaceAuthorizationService } from '../../src/workspaces/workspace-authorization.service';
import { WorkspaceDeletionService } from '../../src/workspaces/workspace-deletion.service';

const URL_ENV = process.env.MEMORY_IT_DATABASE_URL;
const WEBHOOK_SECRET = 'it-webhook-secret';

type Provider = {
  createCheckout: (input: { checkoutId: string; workspaceId: string }) => Promise<unknown>;
  cancelSubscription: (id: string, atPeriodEnd: boolean) => Promise<unknown>;
  getSubscription: (id: string) => Promise<unknown>;
};

describe.skipIf(!URL_ENV)(
  'Billing: subscription binding and cancellation recovery (PostgreSQL)',
  () => {
    let prisma: PrismaClient;
    let entitlements: EntitlementService;
    let billing: BillingService;
    let provider: Provider;
    let deletion: WorkspaceDeletionService;
    let run = 0;
    let event = 0;
    /** custom_data.checkoutId the provider was given, per transaction (what Paddle would echo). */
    const checkoutIds: string[] = [];

    beforeAll(async () => {
      const url = new URL(URL_ENV!);
      if (!url.pathname.endsWith('_it') || url.port === '5432') {
        throw new Error(`Refusing to run integration tests against ${url.host}${url.pathname}`);
      }
      prisma = new PrismaClient({ datasourceUrl: URL_ENV });
      await prisma.$connect();
    });
    afterAll(async () => prisma?.$disconnect());

    beforeEach(() => {
      const config = {
        get: (key: string) =>
          key === 'nodeEnv'
            ? 'test'
            : key === 'appBaseUrl'
              ? 'https://app.example.test'
              : key === 'paddle'
                ? {
                    apiKey: '',
                    webhookSecret: WEBHOOK_SECRET,
                    clientToken: '',
                    environment: 'sandbox',
                    prices: {
                      proMonthly: 'pri_pro_m',
                      proYearly: 'pri_pro_y',
                      teamMonthly: 'pri_team_m',
                      teamYearly: 'pri_team_y',
                    },
                  }
                : undefined,
      };
      entitlements = new EntitlementService(prisma as never);
      billing = new BillingService(
        prisma as never,
        config as never,
        entitlements,
        new UsageService(prisma as never, entitlements),
      );
      provider = (billing as unknown as { provider: Provider }).provider;
      checkoutIds.length = 0;
      const realCreate = provider.createCheckout.bind(provider);
      vi.spyOn(provider, 'createCheckout').mockImplementation(async (input) => {
        checkoutIds.push(input.checkoutId);
        const result = (await realCreate(input)) as { transactionId: string };
        // Distinct provider transactions per call (the sandbox derives it from workspace + plan).
        return { ...result, transactionId: `${result.transactionId}_${checkoutIds.length}` };
      });
      deletion = new WorkspaceDeletionService(
        prisma as never,
        new WorkspaceAuthorizationService(prisma as never),
        billing,
        entitlements,
        { status: 'ready', del: vi.fn(async () => 1) } as never,
      );
    });

    // ── helpers ──────────────────────────────────────────────────────────────

    async function workspace(subscription?: { id: string; planId: string; status: string }) {
      run += 1;
      const ws = `ws_bind_${run}_${Date.now()}`;
      const owner = `bind_owner_${run}_${Date.now()}`;
      await prisma.workspace.create({ data: { id: ws, name: ws, slug: ws } });
      await prisma.user.create({
        data: { id: owner, email: `${owner}@it.test`, passwordHash: 'x', lastWorkspaceId: ws },
      });
      await prisma.workspaceMembership.create({
        data: { workspaceId: ws, userId: owner, role: 'owner', status: 'active' },
      });
      if (subscription) {
        await prisma.workspaceSubscription.create({
          data: {
            workspaceId: ws,
            provider: 'paddle',
            planId: subscription.planId,
            status: subscription.status,
            providerSubscriptionId: subscription.id,
            providerCustomerId: `ctm_of_${subscription.id}`,
            providerUpdatedAt: new Date(Date.now() - 60_000),
          },
        });
      }
      return { ws, owner };
    }

    /** A signed Paddle subscription event exactly as the webhook endpoint receives it. */
    function deliver(
      eventType: string,
      custom: Record<string, unknown>,
      data: { id: string; status: string; price?: string; updatedAt?: Date; customer?: string },
    ) {
      event += 1;
      const raw = Buffer.from(
        JSON.stringify({
          event_id: `evt_bind_${event}_${Date.now()}`,
          event_type: eventType,
          occurred_at: new Date().toISOString(),
          data: {
            id: data.id,
            customer_id: data.customer ?? `ctm_of_${data.id}`,
            status: data.status,
            custom_data: custom,
            items: [{ price: { id: data.price ?? 'pri_pro_m' } }],
            updated_at: (data.updatedAt ?? new Date()).toISOString(),
          },
        }),
      );
      return billing.handleWebhook(
        raw,
        createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex'),
      );
    }

    const row = (ws: string) =>
      prisma.workspaceSubscription.findUnique({ where: { workspaceId: ws } });
    const plan = (ws: string) => {
      entitlements.invalidate(ws);
      return entitlements.getPlanId(ws);
    };
    const cancellation = (subscriptionId: string) =>
      prisma.billingCancellationRequest.findUnique({
        where: { providerSubscriptionId: subscriptionId },
      });
    const makeDue = (ws: string) =>
      prisma.billingCancellationRequest.updateMany({
        where: { workspaceId: ws },
        data: { nextAttemptAt: new Date(Date.now() - 1000) },
      });

    /** Runs the server checkout and returns the id Paddle would echo in custom_data. */
    async function checkout(ws: string, planId: 'pro' | 'team' = 'pro') {
      const before = checkoutIds.length;
      const result = await billing.createCheckout(ws, 'owner@it.test', {
        planId,
        billingCycle: 'monthly',
      });
      return { result, checkoutId: checkoutIds[before] };
    }

    // ── the legitimate flow still works ──────────────────────────────────────

    it('a subscription from a server-created checkout is applied; later events need no checkout id', async () => {
      const { ws } = await workspace();
      const { checkoutId } = await checkout(ws, 'team');
      expect(checkoutId).toMatch(/^chk_[a-f0-9]{32}$/);

      await deliver(
        'subscription.created',
        { workspaceId: ws, checkoutId },
        {
          id: 'sub_legit_1',
          status: 'active',
          price: 'pri_team_m',
        },
      );
      expect(await row(ws)).toMatchObject({
        providerSubscriptionId: 'sub_legit_1',
        planId: 'team',
      });
      expect(await plan(ws)).toBe('team');
      expect(await prisma.billingCheckout.findUnique({ where: { id: checkoutId! } })).toMatchObject(
        { status: 'completed', providerSubscriptionId: 'sub_legit_1' },
      );

      // Out-of-order / follow-up events of the SAME subscription carry no checkout id in some
      // integrations: the subscription is already this workspace's.
      await deliver(
        'subscription.updated',
        { workspaceId: ws },
        {
          id: 'sub_legit_1',
          status: 'past_due',
          price: 'pri_team_m',
        },
      );
      expect((await row(ws))!.status).toBe('past_due');
    });

    it('an activation that arrives BEFORE the created event is applied (bound by the checkout id)', async () => {
      const { ws } = await workspace();
      const { checkoutId } = await checkout(ws);
      await deliver(
        'subscription.activated',
        { workspaceId: ws, checkoutId },
        {
          id: 'sub_ooo_1',
          status: 'active',
        },
      );
      expect(await plan(ws)).toBe('pro');
    });

    // ── F-02: hijack attempts ────────────────────────────────────────────────

    it('[F-02] a subscription bought elsewhere cannot be attached to, or overwrite, a workspace', async () => {
      const victim = await workspace({ id: 'sub_victim_team', planId: 'team', status: 'active' });
      const attacker = await workspace();
      const { checkoutId: attackerCheckout } = await checkout(attacker.ws);
      const before = await row(victim.ws);

      // 1. Paddle.js checkout opened by the attacker with customData naming the victim.
      await deliver(
        'subscription.created',
        { workspaceId: victim.ws },
        {
          id: 'sub_attacker',
          status: 'active',
          customer: 'ctm_attacker',
        },
      );
      // 2. …with a made-up checkout id.
      await deliver(
        'subscription.activated',
        { workspaceId: victim.ws, checkoutId: `chk_${'f'.repeat(32)}` },
        {
          id: 'sub_attacker',
          status: 'active',
          customer: 'ctm_attacker',
        },
      );
      // 3. …with a REAL checkout id, but of the attacker's own workspace.
      await deliver(
        'subscription.updated',
        { workspaceId: victim.ws, checkoutId: attackerCheckout },
        {
          id: 'sub_attacker',
          status: 'active',
          customer: 'ctm_attacker',
        },
      );
      // 4. The attacker cancels their subscription: the victim must not drop to free.
      await deliver(
        'subscription.canceled',
        { workspaceId: victim.ws },
        {
          id: 'sub_attacker',
          status: 'canceled',
          customer: 'ctm_attacker',
        },
      );

      const after = await row(victim.ws);
      expect(after).toMatchObject({
        providerSubscriptionId: 'sub_victim_team',
        providerCustomerId: before!.providerCustomerId,
        planId: 'team',
        status: 'active',
      });
      expect(await plan(victim.ws)).toBe('team');
      // The attacker's own checkout was not consumed by the cross-workspace attempt.
      expect(
        await prisma.billingCheckout.findUnique({ where: { id: attackerCheckout! } }),
      ).toMatchObject({ status: 'pending', providerSubscriptionId: null });
    });

    it('[F-02] a free workspace cannot be given a paid plan by a subscription it never checked out', async () => {
      const { ws } = await workspace();
      await deliver(
        'subscription.created',
        { workspaceId: ws },
        { id: 'sub_gift', status: 'active' },
      );
      expect(await row(ws)).toBeNull();
      expect(await plan(ws)).toBe('free');
    });

    it('[F-02] one checkout binds one subscription: its id cannot be reused for a second one', async () => {
      const { ws } = await workspace();
      const { checkoutId } = await checkout(ws);
      await deliver(
        'subscription.created',
        { workspaceId: ws, checkoutId },
        { id: 'sub_once_1', status: 'active' },
      );
      await deliver(
        'subscription.canceled',
        { workspaceId: ws, checkoutId },
        { id: 'sub_once_1', status: 'canceled' },
      );
      expect(await plan(ws)).toBe('free');
      await deliver(
        'subscription.created',
        { workspaceId: ws, checkoutId },
        { id: 'sub_once_2', status: 'active' },
      );
      expect((await row(ws))!.providerSubscriptionId).toBe('sub_once_1');
      expect(await plan(ws)).toBe('free');
    });

    // ── F-23: second subscriptions ───────────────────────────────────────────

    it('[F-23] repeated and concurrent checkouts for one plan share one provider transaction', async () => {
      const { ws } = await workspace();
      const first = await checkout(ws);
      const second = await checkout(ws);
      expect(second.result.transactionId).toBe(first.result.transactionId);
      expect(vi.mocked(provider.createCheckout)).toHaveBeenCalledTimes(1);
      expect(await prisma.billingCheckout.count({ where: { workspaceId: ws } })).toBe(1);

      const other = await workspace();
      const settled = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          billing.createCheckout(other.ws, 'o@it.test', { planId: 'pro', billingCycle: 'monthly' }),
        ),
      );
      // Whatever the interleaving, the workspace ends with exactly one checkout record and the
      // provider was asked for exactly one more transaction.
      expect(await prisma.billingCheckout.count({ where: { workspaceId: other.ws } })).toBe(1);
      expect(vi.mocked(provider.createCheckout)).toHaveBeenCalledTimes(2);
      expect(settled.some((s) => s.status === 'fulfilled')).toBe(true);
    });

    it('[F-23] a second billable subscription is tracked, not applied, and cancelled on deletion', async () => {
      const { ws, owner } = await workspace();
      const pro = await checkout(ws, 'pro');
      const team = await checkout(ws, 'team'); // a second tab, another plan
      await deliver(
        'subscription.created',
        { workspaceId: ws, checkoutId: pro.checkoutId },
        {
          id: 'sub_dup_pro',
          status: 'active',
        },
      );
      await deliver(
        'subscription.created',
        { workspaceId: ws, checkoutId: team.checkoutId },
        {
          id: 'sub_dup_team',
          status: 'active',
          price: 'pri_team_m',
        },
      );
      // The first subscription stays the workspace's; the second is recorded as a conflict.
      expect(await row(ws)).toMatchObject({ providerSubscriptionId: 'sub_dup_pro', planId: 'pro' });
      expect(
        await prisma.billingCheckout.findUnique({ where: { id: team.checkoutId! } }),
      ).toMatchObject({
        status: 'conflict',
        providerSubscriptionId: 'sub_dup_team',
        subscriptionStatus: 'active',
      });

      // Deleting the workspace cancels BOTH with the provider (nothing keeps billing).
      const cancelled: string[] = [];
      vi.spyOn(provider, 'cancelSubscription').mockImplementation(async (id: string) => {
        cancelled.push(id);
        return {
          providerSubscriptionId: id,
          priceIds: [],
          status: 'cancelled',
          providerUpdatedAt: new Date().toISOString(),
        };
      });
      expect((await deletion.deleteWorkspace(ws, owner)).status).toBe('deleted');
      expect(cancelled.sort()).toEqual(['sub_dup_pro', 'sub_dup_team']);
      expect((await cancellation('sub_dup_team'))!.status).toBe('done');
    });

    // ── F-34: late events of an old subscription ─────────────────────────────

    it('[F-34] a late billable event of an old subscription cannot restore or pin a paid plan', async () => {
      const { ws } = await workspace();
      const a = await checkout(ws, 'team');
      await deliver(
        'subscription.created',
        { workspaceId: ws, checkoutId: a.checkoutId },
        {
          id: 'sub_old_a',
          status: 'active',
          price: 'pri_team_m',
        },
      );
      await deliver(
        'subscription.canceled',
        { workspaceId: ws },
        { id: 'sub_old_a', status: 'canceled', price: 'pri_team_m' },
      );
      expect(await plan(ws)).toBe('free');

      // The user subscribes again (a new checkout, a new subscription).
      await prisma.billingCheckout.updateMany({
        where: { workspaceId: ws },
        data: { createdAt: new Date(0) },
      });
      const b = await checkout(ws, 'pro');
      await deliver(
        'subscription.created',
        { workspaceId: ws, checkoutId: b.checkoutId },
        { id: 'sub_new_b', status: 'active' },
      );
      expect(await row(ws)).toMatchObject({ providerSubscriptionId: 'sub_new_b', planId: 'pro' });

      // A delayed `updated(active)` of the OLD subscription arrives now.
      await deliver(
        'subscription.updated',
        { workspaceId: ws, checkoutId: a.checkoutId },
        {
          id: 'sub_old_a',
          status: 'active',
          price: 'pri_team_m',
          updatedAt: new Date(Date.now() - 3_600_000),
        },
      );
      expect(await row(ws)).toMatchObject({ providerSubscriptionId: 'sub_new_b', planId: 'pro' });

      // …so the cancellation of the current subscription is applied and the plan ends free.
      await deliver(
        'subscription.canceled',
        { workspaceId: ws },
        { id: 'sub_new_b', status: 'canceled' },
      );
      expect((await row(ws))!.status).toBe('cancelled');
      expect(await plan(ws)).toBe('free');
    });

    it('[F-34] with EVERY subscription cancelled, a retried "active" of a finished one does not restore a paid plan', async () => {
      const { ws } = await workspace();
      const a = await checkout(ws, 'team');
      await deliver(
        'subscription.created',
        { workspaceId: ws, checkoutId: a.checkoutId },
        { id: 'sub_fin_a', status: 'active', price: 'pri_team_m' },
      );
      await deliver(
        'subscription.canceled',
        { workspaceId: ws },
        { id: 'sub_fin_a', status: 'canceled', price: 'pri_team_m' },
      );
      await prisma.billingCheckout.updateMany({
        where: { workspaceId: ws },
        data: { createdAt: new Date(0) },
      });
      const b = await checkout(ws, 'pro');
      await deliver(
        'subscription.created',
        { workspaceId: ws, checkoutId: b.checkoutId },
        { id: 'sub_fin_b', status: 'active' },
      );
      await deliver(
        'subscription.canceled',
        { workspaceId: ws },
        { id: 'sub_fin_b', status: 'canceled' },
      );
      expect(await plan(ws)).toBe('free');

      // Late / retried deliveries of old ACTIVE states of both finished subscriptions.
      await deliver(
        'subscription.updated',
        { workspaceId: ws, checkoutId: a.checkoutId },
        { id: 'sub_fin_a', status: 'active', price: 'pri_team_m' },
      );
      await deliver(
        'subscription.updated',
        { workspaceId: ws, checkoutId: b.checkoutId },
        {
          id: 'sub_fin_b',
          status: 'active',
          updatedAt: new Date(Date.now() - 3_600_000),
        },
      );
      expect(await plan(ws)).toBe('free');
      expect((await row(ws))!.status).toBe('cancelled');
    });

    // ── F-03: cancellation during a provider outage ──────────────────────────

    describe('[F-03] cancellation requests', () => {
      const outage = (label: string) => new Error(label);

      it.each(['HTTP 401 (rotated key)', 'HTTP 403', 'HTTP 429', 'HTTP 500', 'ECONNRESET'])(
        'provider failure "%s" never closes the request, however often it repeats',
        async (label) => {
          const { ws, owner } = await workspace({
            id: `sub_out_${run + 1}`,
            planId: 'pro',
            status: 'active',
          });
          const sub = (await row(ws))!.providerSubscriptionId!;
          vi.spyOn(provider, 'cancelSubscription').mockRejectedValue(outage(label));
          vi.spyOn(provider, 'getSubscription').mockRejectedValue(outage(label));

          await expect(deletion.deleteWorkspace(ws, owner)).rejects.toMatchObject({ status: 502 });
          for (let i = 0; i < 8; i += 1) {
            await makeDue(ws);
            await deletion.reconcile();
          }
          expect(await cancellation(sub)).toMatchObject({
            status: 'pending',
            lastErrorCode: 'provider_error',
            notFoundCount: 0,
          });
          expect((await prisma.workspace.findUniqueOrThrow({ where: { id: ws } })).status).toBe(
            'deletion_pending',
          );
          expect((await row(ws))!.status).toBe('active'); // never claimed as cancelled

          // The provider recovers: the same request completes and the deletion finishes.
          vi.mocked(provider.cancelSubscription).mockResolvedValue({
            providerSubscriptionId: sub,
            priceIds: [],
            status: 'cancelled',
            providerUpdatedAt: new Date().toISOString(),
          });
          await makeDue(ws);
          await deletion.reconcile();
          await deletion.reconcile();
          expect((await cancellation(sub))!.status).toBe('done');
          expect((await prisma.workspace.findUniqueOrThrow({ where: { id: ws } })).status).toBe(
            'deleted',
          );
        },
      );

      it('a timeout is retried, not treated as not found', async () => {
        const { ws, owner } = await workspace({
          id: `sub_slow_${run + 1}`,
          planId: 'pro',
          status: 'active',
        });
        const sub = (await row(ws))!.providerSubscriptionId!;
        billing.providerCallTimeoutMs = 30;
        const never = () => new Promise<never>(() => undefined);
        vi.spyOn(provider, 'cancelSubscription').mockImplementation(never);
        vi.spyOn(provider, 'getSubscription').mockImplementation(never);
        await expect(deletion.deleteWorkspace(ws, owner)).rejects.toMatchObject({ status: 502 });
        for (let i = 0; i < 4; i += 1) {
          await makeDue(ws);
          await deletion.reconcile();
        }
        expect(await cancellation(sub)).toMatchObject({
          status: 'pending',
          lastErrorCode: 'timeout',
        });
      });

      it('only an unbroken streak of CONFIRMED not-found answers closes a request', async () => {
        const { ws, owner } = await workspace({
          id: `sub_nf_${run + 1}`,
          planId: 'pro',
          status: 'active',
        });
        const sub = (await row(ws))!.providerSubscriptionId!;
        vi.spyOn(provider, 'cancelSubscription').mockRejectedValue(new Error('cannot cancel'));
        const get = vi.spyOn(provider, 'getSubscription');
        const step = async (answer: 'missing' | 'outage') => {
          if (answer === 'missing') get.mockResolvedValueOnce(null);
          else get.mockRejectedValueOnce(outage('HTTP 503'));
          await makeDue(ws);
          await billing.processCancellationRequests({ workspaceId: ws });
          return cancellation(sub);
        };

        get.mockResolvedValueOnce(null);
        await expect(deletion.deleteWorkspace(ws, owner)).rejects.toMatchObject({ status: 502 });
        expect(await cancellation(sub)).toMatchObject({ status: 'pending', notFoundCount: 1 });
        expect(await step('missing')).toMatchObject({ status: 'pending', notFoundCount: 2 });
        // An outage breaks the streak: earlier failures of any kind no longer count.
        expect(await step('outage')).toMatchObject({
          status: 'pending',
          notFoundCount: 0,
          lastErrorCode: 'provider_error',
        });
        expect(await step('missing')).toMatchObject({ status: 'pending', notFoundCount: 1 });
        expect(await step('missing')).toMatchObject({ status: 'pending', notFoundCount: 2 });
        expect(await step('missing')).toMatchObject({
          status: 'done',
          lastErrorCode: 'not_found_terminal',
        });
      });

      it('the retry schedule binds every caller: no provider call before nextAttemptAt', async () => {
        const { ws, owner } = await workspace({
          id: `sub_bo_${run + 1}`,
          planId: 'pro',
          status: 'active',
        });
        const cancel = vi
          .spyOn(provider, 'cancelSubscription')
          .mockRejectedValue(outage('HTTP 500'));
        vi.spyOn(provider, 'getSubscription').mockRejectedValue(outage('HTTP 500'));
        await expect(deletion.deleteWorkspace(ws, owner)).rejects.toMatchObject({ status: 502 });
        expect(cancel).toHaveBeenCalledTimes(1);
        for (let i = 0; i < 5; i += 1) {
          await expect(deletion.deleteWorkspace(ws, owner)).rejects.toMatchObject({ status: 502 });
        }
        expect(cancel).toHaveBeenCalledTimes(1);
        const request = await prisma.billingCancellationRequest.findFirstOrThrow({
          where: { workspaceId: ws },
        });
        expect(request.attempts).toBe(1);
        expect(request.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
      });

      it('a late webhook reopening a closed request starts its retries over', async () => {
        const { ws, owner } = await workspace({
          id: `sub_reopen_${run + 1}`,
          planId: 'pro',
          status: 'active',
        });
        const sub = (await row(ws))!.providerSubscriptionId!;
        vi.spyOn(provider, 'cancelSubscription').mockResolvedValue({
          providerSubscriptionId: sub,
          priceIds: [],
          status: 'cancelled',
          providerUpdatedAt: new Date().toISOString(),
        });
        await deletion.deleteWorkspace(ws, owner);
        await prisma.billingCancellationRequest.update({
          where: { providerSubscriptionId: sub },
          data: { attempts: 7, notFoundCount: 2 },
        });
        // The provider reports it billable again and is then unreachable.
        vi.mocked(provider.cancelSubscription).mockRejectedValue(outage('HTTP 500'));
        vi.spyOn(provider, 'getSubscription').mockRejectedValue(outage('HTTP 500'));
        await deliver('subscription.updated', { workspaceId: ws }, { id: sub, status: 'active' });
        expect(await cancellation(sub)).toMatchObject({
          status: 'pending',
          attempts: 1,
          notFoundCount: 0,
        });
      });
    });
  },
);
