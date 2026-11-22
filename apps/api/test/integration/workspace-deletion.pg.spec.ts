/**
 * M7 — workspace deletion, subscription lifecycle and GitHub App cleanup, against real
 * PostgreSQL. Real services: authorization, billing (sandbox provider — no network), webhook
 * processing, entitlements, deletion, reliability, GitHub token resolution. Paddle calls are
 * the sandbox provider's (spied / made to fail); the GitHub App token mint is a stub that
 * must never be called for a deleted workspace. Nothing external is contacted.
 */
import { createHmac } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { BillingService } from '../../src/billing/billing.service';
import { EntitlementService } from '../../src/entitlements/entitlements.service';
import { GithubAccessService } from '../../src/github-app/github-access.service';
import { RequestContextService } from '../../src/observability/request-context.service';
import { ReliabilityService } from '../../src/reliability/reliability.service';
import { UsageService } from '../../src/usage/usage.service';
import { resolveWorkspaceIdForUser } from '../../src/workspaces/resolve-workspace-id';
import { WorkspaceAuthorizationService } from '../../src/workspaces/workspace-authorization.service';
import { WorkspaceDeletionService } from '../../src/workspaces/workspace-deletion.service';
import { WorkspaceMembersService } from '../../src/workspaces/members.service';

const URL_ENV = process.env.MEMORY_IT_DATABASE_URL;
const WEBHOOK_SECRET = 'it-webhook-secret';

type Provider = {
  cancelSubscription: (id: string, atPeriodEnd: boolean) => Promise<unknown>;
  getSubscription: (id: string) => Promise<unknown>;
};

describe.skipIf(!URL_ENV)('Workspace deletion lifecycle (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let entitlements: EntitlementService;
  let billing: BillingService;
  let provider: Provider;
  let deletion: WorkspaceDeletionService;
  const redis = { status: 'ready', del: vi.fn(async () => 1) };
  const ctx = new RequestContextService();
  let run = 0;
  /** Paddle-side state per subscription id (see beforeEach). */
  const paddleState = new Map<string, 'active' | 'canceled'>();

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
    // A Paddle model (the sandbox provider does not behave like Paddle): an immediate cancel
    // turns a subscription `canceled`; cancelling a canceled subscription is an error;
    // getSubscription reports the real state.
    paddleState.clear();
    vi.spyOn(provider, 'cancelSubscription').mockImplementation(async (id: string) => {
      if (paddleState.get(id) === 'canceled') throw new Error('subscription_locked_canceled');
      paddleState.set(id, 'canceled');
      return {
        providerSubscriptionId: id,
        priceIds: [],
        status: 'cancelled',
        cancelAtPeriodEnd: false,
        providerUpdatedAt: new Date().toISOString(),
      };
    });
    vi.spyOn(provider, 'getSubscription').mockImplementation(async (id: string) => ({
      providerSubscriptionId: id,
      priceIds: ['pri_pro_m'],
      status: paddleState.get(id) === 'canceled' ? 'cancelled' : 'active',
      providerUpdatedAt: new Date().toISOString(),
    }));
    deletion = new WorkspaceDeletionService(
      prisma as never,
      new WorkspaceAuthorizationService(prisma as never),
      billing,
      entitlements,
      redis as never,
    );
    redis.del.mockClear();
  });

  async function workspace(
    opts: {
      subscription?: { status: string; planId?: string; providerSubscriptionId?: string | null };
      installation?: boolean;
    } = {},
  ) {
    run += 1;
    const ws = `ws_del_${run}_${Date.now()}`;
    await prisma.workspace.create({ data: { id: ws, name: ws, slug: ws } });
    const users: Record<'owner' | 'admin' | 'member', string> = {} as never;
    for (const role of ['owner', 'admin', 'member'] as const) {
      const id = `del_${role}_${run}_${Date.now()}`;
      await prisma.user.create({
        data: { id, email: `${id}@it.test`, passwordHash: 'x', lastWorkspaceId: ws },
      });
      await prisma.workspaceMembership.create({
        data: { workspaceId: ws, userId: id, role, status: 'active' },
      });
      users[role] = id;
    }
    if (opts.subscription) {
      await prisma.workspaceSubscription.create({
        data: {
          workspaceId: ws,
          provider: 'paddle',
          planId: opts.subscription.planId ?? 'pro',
          status: opts.subscription.status,
          providerSubscriptionId:
            opts.subscription.providerSubscriptionId === undefined
              ? `sub_${ws}`
              : opts.subscription.providerSubscriptionId,
          providerUpdatedAt: new Date(Date.now() - 60_000),
        },
      });
    }
    if (opts.installation) {
      await prisma.gitHubAppInstallation.create({
        data: {
          workspaceId: ws,
          installationId: `${run}${Date.now()}`,
          accountLogin: 'acme',
          accountType: 'Organization',
          status: 'active',
        },
      });
    }
    return { ws, ...users };
  }
  const status = async (ws: string) =>
    (await prisma.workspace.findUniqueOrThrow({ where: { id: ws } })).status;
  const sub = (ws: string) =>
    prisma.workspaceSubscription.findUnique({ where: { workspaceId: ws } });

  function webhook(eventId: string, ws: string, data: Record<string, unknown>) {
    const raw = Buffer.from(
      JSON.stringify({
        event_id: eventId,
        event_type: 'subscription.updated',
        occurred_at: new Date().toISOString(),
        data: {
          custom_data: { workspaceId: ws },
          items: [{ price: { id: 'pri_pro_m' } }],
          ...data,
        },
      }),
    );
    return billing.handleWebhook(
      raw,
      createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex'),
    );
  }

  // ── authorization ────────────────────────────────────────────────────────────────────────

  it('only the owner can delete; admin and member are refused and nothing changes', async () => {
    const w = await workspace({ subscription: { status: 'active' } });
    for (const user of [w.admin, w.member]) {
      await expect(deletion.deleteWorkspace(w.ws, user)).rejects.toMatchObject({ status: 403 });
    }
    await expect(deletion.deleteWorkspace(w.ws, 'not-a-member')).rejects.toMatchObject({
      status: 403,
    });
    expect(await status(w.ws)).toBe('active');
    expect(provider.cancelSubscription).not.toHaveBeenCalled();
  });

  // ── subscription states ──────────────────────────────────────────────────────────────────

  it('no subscription: deleted, no billing call', async () => {
    const w = await workspace();
    expect(await deletion.deleteWorkspace(w.ws, w.owner)).toMatchObject({
      status: 'deleted',
      billing: 'none',
    });
    expect(await status(w.ws)).toBe('deleted');
    expect(provider.cancelSubscription).not.toHaveBeenCalled();
  });

  it.each(['active', 'trialing', 'past_due', 'paused'])(
    '%s subscription: cancelled immediately with the provider before the workspace is deleted',
    async (subscriptionStatus) => {
      const w = await workspace({ subscription: { status: subscriptionStatus } });
      const result = await deletion.deleteWorkspace(w.ws, w.owner);
      expect(result.billing).toBe('cancelled_with_provider');
      expect(provider.cancelSubscription).toHaveBeenCalledExactlyOnceWith(`sub_${w.ws}`, false);
      const row = await sub(w.ws);
      // Paddle's answer (`canceled` → cancelled), stored; the history row is kept.
      expect(row?.status).toBe('cancelled');
      expect(row?.providerSubscriptionId).toBe(`sub_${w.ws}`);
      expect(await status(w.ws)).toBe('deleted');
      expect(await entitlements.getPlanId(w.ws)).toBe('free');
    },
  );

  it('already cancelled / expired / free plan: no provider call', async () => {
    for (const subscription of [
      { status: 'cancelled' },
      { status: 'expired' },
      { status: 'active', planId: 'free', providerSubscriptionId: null },
    ]) {
      const w = await workspace({ subscription });
      expect((await deletion.deleteWorkspace(w.ws, w.owner)).billing).toBe('none');
    }
    expect(provider.cancelSubscription).not.toHaveBeenCalled();
  });

  it('a billable row without a provider subscription is closed locally', async () => {
    const w = await workspace({ subscription: { status: 'active', providerSubscriptionId: null } });
    expect((await deletion.deleteWorkspace(w.ws, w.owner)).billing).toBe('cancelled_locally');
    expect((await sub(w.ws))?.status).toBe('cancelled');
    expect(provider.cancelSubscription).not.toHaveBeenCalled();
  });

  // ── provider failures ────────────────────────────────────────────────────────────────────

  it('provider failure: 502, workspace stays pending (unusable), retry completes it', async () => {
    const w = await workspace({ subscription: { status: 'active' } });
    vi.mocked(provider.cancelSubscription).mockRejectedValueOnce(new Error('paddle down'));
    vi.spyOn(provider, 'getSubscription').mockResolvedValueOnce({
      providerSubscriptionId: `sub_${w.ws}`,
      priceIds: ['pri_pro_m'],
      status: 'active',
    });
    const error = await deletion.deleteWorkspace(w.ws, w.owner).catch((e: unknown) => e);
    expect((error as { getStatus(): number }).getStatus()).toBe(502);
    expect((error as { getResponse(): { code: string } }).getResponse().code).toBe(
      'BILLING_CANCELLATION_FAILED',
    );
    expect(await status(w.ws)).toBe('deletion_pending');
    expect((await sub(w.ws))?.status).toBe('active'); // never claimed as cancelled
    // Pending deletion is not usable.
    await expect(resolveWorkspaceIdForUser(prisma as never, w.owner, w.ws)).rejects.toMatchObject({
      status: 403,
    });
    expect(await entitlements.getPlanId(w.ws)).toBe('free');

    // F-03: the retry schedule also binds the owner — an immediate retry makes no provider
    // call (it cannot burn through the attempts during an outage) and the deletion stays open.
    const callsAfterFailure = vi.mocked(provider.cancelSubscription).mock.calls.length;
    const tooSoon = await deletion.deleteWorkspace(w.ws, w.owner).catch((e: unknown) => e);
    expect((tooSoon as { getStatus(): number }).getStatus()).toBe(502);
    expect(vi.mocked(provider.cancelSubscription).mock.calls.length).toBe(callsAfterFailure);
    expect(await status(w.ws)).toBe('deletion_pending');

    // Once the backoff has elapsed, the retry completes it.
    await prisma.billingCancellationRequest.updateMany({
      where: { workspaceId: w.ws },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    });
    const retried = await deletion.deleteWorkspace(w.ws, w.owner);
    expect(retried).toMatchObject({ status: 'deleted', billing: 'cancelled_with_provider' });
    expect(await status(w.ws)).toBe('deleted');
  });

  it('provider error but the subscription is already cancelled there: verified, then deleted', async () => {
    const w = await workspace({ subscription: { status: 'active' } });
    vi.mocked(provider.cancelSubscription).mockRejectedValueOnce(new Error('already canceled'));
    vi.spyOn(provider, 'getSubscription').mockResolvedValueOnce({
      providerSubscriptionId: `sub_${w.ws}`,
      priceIds: ['pri_pro_m'],
      status: 'cancelled',
      providerUpdatedAt: new Date().toISOString(),
    });
    expect((await deletion.deleteWorkspace(w.ws, w.owner)).billing).toBe(
      'already_cancelled_with_provider',
    );
    expect((await sub(w.ws))?.status).toBe('cancelled');
  });

  // ── idempotency / concurrency ────────────────────────────────────────────────────────────

  it('repeated deletion is idempotent: one provider call', async () => {
    const w = await workspace({ subscription: { status: 'active' } });
    await deletion.deleteWorkspace(w.ws, w.owner);
    expect(await deletion.deleteWorkspace(w.ws, w.owner)).toMatchObject({ alreadyDeleted: true });
    expect(provider.cancelSubscription).toHaveBeenCalledTimes(1);
  });

  it('concurrent deletions cancel exactly once and all succeed', async () => {
    const w = await workspace({ subscription: { status: 'active' }, installation: true });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => deletion.deleteWorkspace(w.ws, w.owner)),
    );
    expect(results.every((r) => r.status === 'deleted')).toBe(true);
    expect(results.filter((r) => !r.alreadyDeleted)).toHaveLength(1);
    expect(provider.cancelSubscription).toHaveBeenCalledTimes(1);
    expect(await status(w.ws)).toBe('deleted');
  });

  // ── webhooks ─────────────────────────────────────────────────────────────────────────────

  it('a delayed activation webhook after deletion is cancelled, never reactivates anything', async () => {
    const w = await workspace({ subscription: { status: 'active' } });
    await deletion.deleteWorkspace(w.ws, w.owner);
    vi.mocked(provider.cancelSubscription).mockClear();
    // Paddle reports the subscription active again (e.g. a checkout finished after deletion).
    await webhook(`evt_late_${w.ws}`, w.ws, {
      id: `sub_new_${w.ws}`,
      status: 'active',
      updated_at: new Date(Date.now() + 1000).toISOString(),
    });
    expect(provider.cancelSubscription).toHaveBeenCalledExactlyOnceWith(`sub_new_${w.ws}`, false);
    expect((await sub(w.ws))?.status).not.toBe('active');
    expect(await status(w.ws)).toBe('deleted');
    expect(await entitlements.getPlanId(w.ws)).toBe('free');
  });

  it('duplicate and out-of-order webhooks after deletion change nothing', async () => {
    const w = await workspace({ subscription: { status: 'active' } });
    await deletion.deleteWorkspace(w.ws, w.owner);
    const afterDelete = await sub(w.ws);
    vi.mocked(provider.cancelSubscription).mockClear();
    // Older than the cancellation the provider confirmed: ignored as stale.
    await webhook(`evt_old_${w.ws}`, w.ws, {
      id: `sub_${w.ws}`,
      status: 'active',
      updated_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    // The same event again: recorded once.
    await webhook(`evt_old_${w.ws}`, w.ws, {
      id: `sub_${w.ws}`,
      status: 'active',
      updated_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    expect((await sub(w.ws))?.status).toBe(afterDelete?.status);
    // N-12: a billable report for a deleted workspace is never trusted on timestamps alone —
    // the provider is asked (already canceled there: verified, no state change).
    expect(provider.cancelSubscription).toHaveBeenCalledTimes(1);
    expect(paddleState.get(`sub_${w.ws}`)).toBe('canceled');
    expect(
      await prisma.billingCancellationRequest.findUnique({
        where: { providerSubscriptionId: `sub_${w.ws}` },
      }),
    ).toMatchObject({ status: 'done' });
    expect(await prisma.billingWebhookEvent.count({ where: { eventId: `evt_old_${w.ws}` } })).toBe(
      1,
    );
    expect(await status(w.ws)).toBe('deleted');
  });

  it('webhooks for active workspaces are unaffected (no auto-cancel)', async () => {
    const w = await workspace({ subscription: { status: 'trialing' } });
    await webhook(`evt_active_${w.ws}`, w.ws, {
      id: `sub_${w.ws}`,
      status: 'active',
      updated_at: new Date().toISOString(),
    });
    expect((await sub(w.ws))?.status).toBe('active');
    expect(provider.cancelSubscription).not.toHaveBeenCalled();
    expect(await entitlements.getPlanId(w.ws)).toBe('pro');
  });

  // ── GitHub App ───────────────────────────────────────────────────────────────────────────

  it('GitHub: the deleted workspace is unlinked and its token cache revoked; others untouched', async () => {
    const deleted = await workspace({ installation: true });
    const other = await workspace({ installation: true });
    const install = await prisma.gitHubAppInstallation.findUniqueOrThrow({
      where: { workspaceId: deleted.ws },
    });
    const result = await deletion.deleteWorkspace(deleted.ws, deleted.owner);
    expect(result.githubAppUnlinked).toBe(true);
    expect(
      await prisma.gitHubAppInstallation.findUnique({ where: { workspaceId: deleted.ws } }),
    ).toBeNull();
    expect(redis.del).toHaveBeenCalledWith(`gh:app:installation-token:${install.installationId}`);
    expect(
      (await prisma.gitHubAppInstallation.findUnique({ where: { workspaceId: other.ws } }))?.status,
    ).toBe('active');
    // An installation belongs to one workspace (cannot be shared)…
    await expect(
      prisma.gitHubAppInstallation.create({
        data: {
          workspaceId: deleted.ws === other.ws ? 'x' : (await workspace()).ws,
          installationId: (
            await prisma.gitHubAppInstallation.findUniqueOrThrow({
              where: { workspaceId: other.ws },
            })
          ).installationId,
          accountLogin: 'acme',
          accountType: 'Organization',
        },
      }),
    ).rejects.toThrow();
    // …and the freed installation can be linked again by its owner to a new workspace.
    const fresh = await workspace();
    await expect(
      prisma.gitHubAppInstallation.create({
        data: {
          workspaceId: fresh.ws,
          installationId: install.installationId,
          accountLogin: 'acme',
          accountType: 'Organization',
        },
      }),
    ).resolves.toBeTruthy();
  });

  it('deleted (and pending) workspaces resolve no GitHub token; no installation token is minted', async () => {
    const w = await workspace({ installation: true });
    const mint = vi.fn(async () => 'ghs_never');
    const access = new GithubAccessService(
      prisma as never,
      ctx,
      { isAppAuthEnabled: () => true, mintInstallationAccessToken: mint } as never,
      {
        getActiveInstallationId: async (id: string) =>
          (await prisma.gitHubAppInstallation.findUnique({ where: { workspaceId: id } }))
            ?.installationId ?? null,
      } as never,
      {
        getDecryptedToken: vi.fn(async () => 'ghp_personal'),
      } as never,
    );
    // Mocked GitHub (H1): the owner's own token can read the repository.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => Response.json({ permissions: { pull: true } }));
    const resolve = () =>
      access.resolveRepositoryAccess(w.owner, {
        owner: 'acme',
        repository: 'app',
        access: 'read',
        workspaceId: w.ws,
      });
    try {
      await expect(resolve()).resolves.toMatchObject({ ok: true, source: 'installation' });
      mint.mockClear();
      await prisma.workspace.update({ where: { id: w.ws }, data: { status: 'deletion_pending' } });
      await expect(resolve()).rejects.toMatchObject({ status: 403 });
      await prisma.workspace.update({ where: { id: w.ws }, data: { status: 'active' } });
      await deletion.deleteWorkspace(w.ws, w.owner);
      await expect(resolve()).rejects.toMatchObject({ status: 403 });
      expect(mint).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  // ── access after deletion ────────────────────────────────────────────────────────────────

  it('deleted workspaces refuse AI/workspace resolution, workflow writes and guarded routes', async () => {
    const w = await workspace({ subscription: { status: 'active' } });
    await deletion.deleteWorkspace(w.ws, w.owner);
    // The shared gate used by AI reviews, Systems, Project Memory, workflows and GitHub calls.
    await expect(resolveWorkspaceIdForUser(prisma as never, w.owner, w.ws)).rejects.toMatchObject({
      status: 403,
    });
    // Workflow execution write.
    const reliability = new ReliabilityService(prisma as never);
    await expect(
      ctx.run({ workspaceId: w.ws } as never, () =>
        reliability.startExecution(w.owner, { workflowId: 'wf', goal: 'Review PR' }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    // Route guard (billing, history, memory audit, settings…) — active workspaces only.
    const authorization = new WorkspaceAuthorizationService(prisma as never);
    await expect(
      authorization.assertAccess({
        userId: w.owner,
        workspaceId: w.ws,
        permission: 'workspace:read',
      }),
    ).rejects.toMatchObject({ status: 403 });
    // Fallback resolution never lands on the deleted workspace either.
    expect(await resolveWorkspaceIdForUser(prisma as never, w.owner).catch(() => null)).not.toBe(
      w.ws,
    );
  });

  // ── retention ────────────────────────────────────────────────────────────────────────────

  it('billing history and other workspaces are preserved', async () => {
    const w = await workspace({ subscription: { status: 'active' } });
    const other = await workspace({ subscription: { status: 'active' }, installation: true });
    await webhook(`evt_hist_${w.ws}`, w.ws, {
      id: `sub_${w.ws}`,
      status: 'active',
      updated_at: new Date().toISOString(),
    });
    await prisma.workspaceUsageEvent
      .create({
        data: {
          workspaceId: w.ws,
          userId: w.owner,
          kind: 'ai_request',
          units: 1,
          periodKey: '2026-11',
        } as never,
      })
      .catch(() => undefined); // schema-dependent; history assertion below covers webhooks
    await deletion.deleteWorkspace(w.ws, w.owner);
    expect(await prisma.billingWebhookEvent.count({ where: { eventId: `evt_hist_${w.ws}` } })).toBe(
      1,
    );
    expect(await sub(w.ws)).not.toBeNull(); // subscription record kept (not deleted)
    expect(await status(other.ws)).toBe('active');
    expect((await sub(other.ws))?.status).toBe('active');
    expect(await entitlements.getPlanId(other.ws)).toBe('pro');
    expect(
      (await prisma.gitHubAppInstallation.findUnique({ where: { workspaceId: other.ws } }))?.status,
    ).toBe('active');
  });

  // ── final-audit remediation: recovery, races, timeouts (N-2, N-3, N-11, N-12, N-13) ─────

  const request = (subscriptionId: string) =>
    prisma.billingCancellationRequest.findUnique({
      where: { providerSubscriptionId: subscriptionId },
    });
  const makeDue = (ws: string) =>
    prisma.billingCancellationRequest.updateMany({
      where: { workspaceId: ws },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    });

  it('N-2/N-3: a failed cancellation is durable, visible to the owner, and the reconciler completes the deletion', async () => {
    const w = await workspace({ subscription: { status: 'active' } });
    vi.mocked(provider.cancelSubscription).mockRejectedValueOnce(new Error('paddle down'));
    vi.mocked(provider.getSubscription).mockRejectedValueOnce(new Error('paddle down'));
    await expect(deletion.deleteWorkspace(w.ws, w.owner)).rejects.toMatchObject({ status: 502 });
    expect(await status(w.ws)).toBe('deletion_pending');
    expect(await request(`sub_${w.ws}`)).toMatchObject({
      status: 'pending',
      attempts: 1,
      lastErrorCode: 'provider_error',
    });
    // The owner (only) can find it again after navigating away.
    expect(await deletion.listPendingDeletions(w.owner)).toEqual([
      expect.objectContaining({
        workspaceId: w.ws,
        openCancellations: 1,
        lastErrorCode: 'provider_error',
      }),
    ]);
    expect(await deletion.listPendingDeletions(w.admin)).toEqual([]);
    // Nothing happens before the backoff elapses; then the reconciler finishes the job.
    await deletion.reconcile(); // (other suites' pending workspaces may be reconciled too)
    expect(await status(w.ws)).toBe('deletion_pending');
    expect(await request(`sub_${w.ws}`)).toMatchObject({ status: 'pending', attempts: 1 });
    await makeDue(w.ws);
    await deletion.reconcile();
    expect(await status(w.ws)).toBe('deleted');
    expect(paddleState.get(`sub_${w.ws}`)).toBe('canceled');
    expect(await request(`sub_${w.ws}`)).toMatchObject({ status: 'done' });
    expect((await sub(w.ws))?.status).toBe('cancelled');
  });

  it('N-11: a hanging provider is bounded by a timeout; no transaction is held; retry completes', async () => {
    const w = await workspace({ subscription: { status: 'active' } });
    billing.providerCallTimeoutMs = 150;
    vi.mocked(provider.cancelSubscription).mockImplementationOnce(
      () => new Promise(() => undefined),
    );
    vi.mocked(provider.getSubscription).mockImplementationOnce(() => new Promise(() => undefined));
    const started = Date.now();
    await expect(deletion.deleteWorkspace(w.ws, w.owner)).rejects.toMatchObject({ status: 502 });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(await request(`sub_${w.ws}`)).toMatchObject({
      status: 'pending',
      lastErrorCode: 'timeout',
    });
    // The workspace row is not locked: a membership read/write proceeds immediately.
    await prisma.workspace.findUniqueOrThrow({ where: { id: w.ws } });
    await makeDue(w.ws);
    await expect(deletion.deleteWorkspace(w.ws, w.owner)).resolves.toMatchObject({
      status: 'deleted',
    });
  });

  it('crash windows: Paddle cancelled but the response was lost / finalize never ran — retry recovers without a second charge-affecting call', async () => {
    const w = await workspace({ subscription: { status: 'active' } });
    // Paddle cancels, then the connection drops before we see the response.
    vi.mocked(provider.cancelSubscription).mockImplementationOnce(async (id: string) => {
      paddleState.set(id, 'canceled');
      throw new TypeError('fetch failed');
    });
    await expect(deletion.deleteWorkspace(w.ws, w.owner)).resolves.toMatchObject({
      status: 'deleted',
      billing: 'already_cancelled_with_provider',
    });
    // Second workspace: cancellation confirmed, then the process died before finalizing.
    const v = await workspace({ subscription: { status: 'active' } });
    await prisma.workspace.update({ where: { id: v.ws }, data: { status: 'deletion_pending' } });
    await prisma.billingCancellationRequest.create({
      data: {
        workspaceId: v.ws,
        providerSubscriptionId: `sub_${v.ws}`,
        reason: 'workspace_deletion',
        status: 'done',
        completedAt: new Date(),
      },
    });
    paddleState.set(`sub_${v.ws}`, 'canceled');
    vi.mocked(provider.cancelSubscription).mockClear();
    await deletion.reconcile();
    expect(await status(v.ws)).toBe('deleted');
    expect(provider.cancelSubscription).not.toHaveBeenCalled();
  });

  it('N-12: a second subscription activated DURING deletion is recorded and cancelled too', async () => {
    const w = await workspace({ subscription: { status: 'active' } });
    vi.mocked(provider.cancelSubscription).mockRejectedValueOnce(new Error('paddle down'));
    vi.mocked(provider.getSubscription).mockRejectedValueOnce(new Error('paddle down'));
    await expect(deletion.deleteWorkspace(w.ws, w.owner)).rejects.toMatchObject({ status: 502 });
    // A checkout opened before deletion completes now: subscription B becomes active, with a
    // timestamp OLDER than anything stored (out of order across subscriptions).
    await webhook(`evt_b_${w.ws}`, w.ws, {
      id: `sub_b_${w.ws}`,
      status: 'active',
      updated_at: new Date(Date.now() - 60 * 60_000).toISOString(),
    });
    expect(paddleState.get(`sub_b_${w.ws}`)).toBe('canceled'); // cancelled right away
    expect(await request(`sub_b_${w.ws}`)).toMatchObject({
      status: 'done',
      reason: 'late_webhook',
    });
    await makeDue(w.ws);
    await deletion.deleteWorkspace(w.ws, w.owner);
    expect(await status(w.ws)).toBe('deleted');
    expect(paddleState.get(`sub_${w.ws}`)).toBe('canceled');
  });

  it('N-3: a late activation whose cancellation fails is retried until confirmed (never forgotten)', async () => {
    const w = await workspace({ subscription: { status: 'active' } });
    await deletion.deleteWorkspace(w.ws, w.owner);
    vi.mocked(provider.cancelSubscription).mockRejectedValueOnce(new Error('paddle down'));
    vi.mocked(provider.getSubscription).mockRejectedValueOnce(new Error('paddle down'));
    await webhook(`evt_c_${w.ws}`, w.ws, {
      id: `sub_c_${w.ws}`,
      status: 'active',
      updated_at: new Date(Date.now() + 1000).toISOString(),
    });
    expect(await request(`sub_c_${w.ws}`)).toMatchObject({ status: 'pending', attempts: 1 });
    expect(paddleState.get(`sub_c_${w.ws}`)).toBeUndefined();
    await makeDue(w.ws);
    await deletion.reconcile();
    expect(paddleState.get(`sub_c_${w.ws}`)).toBe('canceled');
    expect(await request(`sub_c_${w.ws}`)).toMatchObject({ status: 'done' });
    expect(await status(w.ws)).toBe('deleted'); // never reactivated
  });

  it('N-13: an owner demoted while deleting — deletion and demotion never both take effect', async () => {
    for (let i = 0; i < 5; i += 1) {
      const w = await workspace({ subscription: { status: 'active' } });
      const second = `del_owner2_${run}_${i}_${Date.now()}`;
      await prisma.user.create({
        data: { id: second, email: `${second}@it.test`, passwordHash: 'x' },
      });
      await prisma.workspaceMembership.create({
        data: { workspaceId: w.ws, userId: second, role: 'owner', status: 'active' },
      });
      const ownerMembership = await prisma.workspaceMembership.findFirstOrThrow({
        where: { workspaceId: w.ws, userId: w.owner },
      });
      const members = new WorkspaceMembersService(
        prisma as never,
        new WorkspaceAuthorizationService(prisma as never),
      );
      const [del, demote] = await Promise.allSettled([
        deletion.deleteWorkspace(w.ws, w.owner),
        members.changeRole(w.ws, second, ownerMembership.id, { role: 'member' }),
      ]);
      const deleted = (await status(w.ws)) !== 'active';
      const demoted =
        (await prisma.workspaceMembership.findUniqueOrThrow({ where: { id: ownerMembership.id } }))
          .role === 'member';
      expect(deleted && demoted).toBe(false); // serialized: one decision wins
      expect(deleted || demoted).toBe(true);
      expect(del.status === 'fulfilled').toBe(deleted);
      expect(demote.status === 'fulfilled').toBe(demoted);
    }
  });

  it('adversarial N5: a subscription the provider never knows is closed after repeated not_found; deletion completes', async () => {
    const w = await workspace({ subscription: { status: 'active' } });
    vi.mocked(provider.cancelSubscription).mockRejectedValue(new Error('not_found'));
    vi.mocked(provider.getSubscription).mockResolvedValue(null);
    await expect(deletion.deleteWorkspace(w.ws, w.owner)).rejects.toMatchObject({ status: 502 });
    for (let i = 0; i < 2; i += 1) {
      await makeDue(w.ws);
      await deletion.reconcile();
    }
    expect(await request(`sub_${w.ws}`)).toMatchObject({
      status: 'done',
      lastErrorCode: 'not_found_terminal',
    });
    await deletion.reconcile();
    expect(await status(w.ws)).toBe('deleted');
  });
  // ── F-25: an owner cannot strand their own account ───────────────────────

  describe('[F-25] deleting the only workspace', () => {
    /** A user who owns `count` free workspaces (no subscription row = free plan). */
    async function ownerOf(count: number) {
      run += 1;
      const owner = `del_solo_${run}_${Date.now()}`;
      await prisma.user.create({
        data: { id: owner, email: `${owner}@it.test`, passwordHash: 'x' },
      });
      const workspaces: string[] = [];
      for (let i = 0; i < count; i += 1) {
        const ws = `ws_solo_${run}_${i}_${Date.now()}`;
        await prisma.workspace.create({
          data: { id: ws, name: ws, slug: ws, createdByUserId: owner },
        });
        await prisma.workspaceMembership.create({
          data: { workspaceId: ws, userId: owner, role: 'owner', status: 'active' },
        });
        workspaces.push(ws);
      }
      return { owner, workspaces };
    }

    it('with both free slots used, the second deletion is refused: the account keeps a workspace', async () => {
      const { owner, workspaces } = await ownerOf(2);
      expect((await deletion.deleteWorkspace(workspaces[0]!, owner)).status).toBe('deleted');
      const error = await deletion.deleteWorkspace(workspaces[1]!, owner).catch((e: unknown) => e);
      expect(
        (error as { getResponse(): { code: string; details?: { reason?: string } } }).getResponse(),
      ).toMatchObject({
        code: 'WORKSPACE_LIMIT_REACHED',
        details: { reason: 'last_workspace' },
      });
      expect(await status(workspaces[1]!)).toBe('active');
      // Still usable: not stranded.
      await expect(resolveWorkspaceIdForUser(prisma as never, owner)).resolves.toBe(workspaces[1]);
    });

    it('a single workspace can be deleted while a free slot remains (a new one can be created)', async () => {
      const { owner, workspaces } = await ownerOf(1);
      expect((await deletion.deleteWorkspace(workspaces[0]!, owner)).status).toBe('deleted');
    });

    it('the quota-cycling safeguard is unchanged: the deleted workspace still occupies its slot', async () => {
      const { owner, workspaces } = await ownerOf(2);
      await deletion.deleteWorkspace(workspaces[0]!, owner);
      const { countFreeWorkspaceSlots } = await import('../../src/workspaces/workspace-limits');
      expect(await countFreeWorkspaceSlots(prisma as never, owner)).toBe(2);
    });

    it('membership of another active workspace is enough: the last OWNED workspace can be deleted', async () => {
      const { owner, workspaces } = await ownerOf(2);
      const elsewhere = await workspace();
      await prisma.workspaceMembership.create({
        data: { workspaceId: elsewhere.ws, userId: owner, role: 'member', status: 'active' },
      });
      await deletion.deleteWorkspace(workspaces[0]!, owner);
      expect((await deletion.deleteWorkspace(workspaces[1]!, owner)).status).toBe('deleted');
    });

    it('a deletion that was already started can always be retried', async () => {
      const { owner, workspaces } = await ownerOf(2);
      await deletion.deleteWorkspace(workspaces[0]!, owner);
      await prisma.workspace.update({
        where: { id: workspaces[1]! },
        data: { status: 'deletion_pending' },
      });
      expect((await deletion.deleteWorkspace(workspaces[1]!, owner)).status).toBe('deleted');
    });
  });
});
