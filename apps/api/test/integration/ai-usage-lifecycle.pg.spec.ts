/**
 * AI operation lifecycle on PostgreSQL: leases and crash recovery, idempotent and concurrent
 * settlement, database failures during settlement, lost-response retries (replay), and the
 * subscription-status entitlement policy.
 *
 * Real: PrismaClient/PostgreSQL, UsageService, EntitlementService, FeatureGate, workspace
 * resolution, PR planner and orchestrator. Stubbed: the model (`ai.generateText`) and the
 * GitHub diff. Run via `pnpm --filter @project-x/api test:integration`.
 */
import { HttpException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { usagePeriodKey } from '@project-x/shared';
import { AIAction } from '@project-x/types';
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiService } from '../../src/ai/ai.service';
import { makeFile, makePatch } from '../../src/ai/pr-review/pr-review-fixtures';
import { PrReviewOrchestrator } from '../../src/ai/pr-review/pr-review-orchestrator.service';
import { PromptRegistry } from '../../src/ai/prompts/prompt.registry';
import { EntitlementService } from '../../src/entitlements/entitlements.service';
import { FeatureGate } from '../../src/entitlements/feature-gate';
import { PROVIDER_WORK_REFUNDS_PER_PERIOD, UsageService } from '../../src/usage/usage.service';

const generateTextMock = vi.fn();
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    generateText: (...a: unknown[]) => generateTextMock(...a),
    streamText: vi.fn(),
  };
});

const URL_ENV = process.env.MEMORY_IT_DATABASE_URL;
const PRO_LIMIT = 500;
const answer = () => ({
  text: 'An answer.',
  output: { summary: 'fine', findings: [] },
  finishReason: 'stop',
  usage: { inputTokens: 800, outputTokens: 60, totalTokens: 860 },
});

describe.skipIf(!URL_ENV)('AI operation lifecycle on PostgreSQL', () => {
  let prisma: PrismaClient;
  let usage: UsageService;
  let run = 0;
  const diff = { resolve: vi.fn() };

  beforeAll(async () => {
    const url = new URL(URL_ENV!);
    if (!url.pathname.endsWith('_it') || url.port === '5432') {
      throw new Error(`Refusing to run integration tests against ${url.host}${url.pathname}`);
    }
    prisma = new PrismaClient({ datasourceUrl: URL_ENV });
    await prisma.$connect();
    usage = new UsageService(prisma as never, new EntitlementService(prisma as never));
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  beforeEach(() => {
    generateTextMock.mockReset().mockImplementation(async () => answer());
    diff.resolve.mockReset().mockResolvedValue({
      source: 'github_api',
      files: [makeFile('src/a.ts', makePatch(5))],
      totalFiles: 1,
    });
  });

  async function seedWorkspace() {
    run += 1;
    const ws = `ws_life_${run}_${Date.now()}`;
    await prisma.workspace.create({ data: { id: ws, name: ws, slug: ws } });
    await prisma.workspaceSubscription.create({
      data: { workspaceId: ws, provider: 'paddle', planId: 'pro', status: 'active' },
    });
    return ws;
  }

  async function seedUser(ws: string) {
    run += 1;
    const user = `life_user_${run}_${Date.now()}`;
    await prisma.user.create({
      data: {
        id: user,
        email: `${user}@it.test`,
        passwordHash: 'x',
        lastWorkspaceId: ws,
        emailVerifiedAt: new Date(),
      },
    });
    await prisma.workspaceMembership.create({
      data: { workspaceId: ws, userId: user, role: 'owner', status: 'active' },
    });
    return user;
  }

  async function seed() {
    const ws = await seedWorkspace();
    return { ws, user: await seedUser(ws) };
  }

  async function count(ws: string) {
    const row = await prisma.workspaceUsageCounter.findUnique({
      where: {
        workspaceId_metric_periodKey: {
          workspaceId: ws,
          metric: 'ai_action',
          periodKey: usagePeriodKey(),
        },
      },
    });
    return row?.count ?? 0;
  }

  async function exhaust(ws: string) {
    await prisma.workspaceUsageCounter.upsert({
      where: {
        workspaceId_metric_periodKey: {
          workspaceId: ws,
          metric: 'ai_action',
          periodKey: usagePeriodKey(),
        },
      },
      create: {
        workspaceId: ws,
        metric: 'ai_action',
        periodKey: usagePeriodKey(),
        count: PRO_LIMIT,
      },
      update: { count: PRO_LIMIT },
    });
  }

  /** Model executions so far: PR review batch calls + standard action calls. */
  const modelCalls = () => generateTextMock.mock.calls.length;

  function service() {
    const featureGate = new FeatureGate(new EntitlementService(prisma as never));
    const modelFactory = {
      getDefaultModel: () => 'm',
      getProviderName: () => 'openai',
      getModelName: () => 'm',
    };
    const obs = {
      createOperationId: () => 'op',
      observeGenerate: async ({
        call,
      }: {
        call: () => Promise<{
          result: unknown;
          usageRaw?: { inputTokens?: number; outputTokens?: number };
        }>;
      }) => {
        const r = await call();
        return {
          result: r.result,
          observation: {
            usage: { inputTokens: r.usageRaw?.inputTokens, outputTokens: r.usageRaw?.outputTokens },
            cost: {},
            durationMs: 1,
          },
        };
      },
    };
    const health = { recordSignal: vi.fn() };
    return new AiService(
      new PromptRegistry(),
      modelFactory as never,
      {
        get: () => ({
          requestTimeoutMs: 1_000,
          maxInputCharacters: 20_000,
          prReview: { reviewTimeoutMs: 60_000 },
        }),
      } as never,
      {
        getForUser: vi.fn(async () => ({
          maxOutputTokens: 600,
          responseStyle: 'CONCISE',
          includePageContext: true,
        })),
      } as never,
      prisma as never,
      featureGate,
      usage,
      obs as never,
      { get: () => ({}), patch: vi.fn() } as never,
      health as never,
      undefined,
      undefined,
      diff as never,
      new PrReviewOrchestrator(modelFactory as never, obs as never, health as never),
    );
  }

  const review = (pr: number, executionId?: string) =>
    ({
      action: AIAction.REVIEW_ENTIRE_PR,
      text: 'Review this PR.',
      ...(executionId ? { executionId } : {}),
      context: {
        type: 'github',
        url: `https://github.com/acme/app/pull/${pr}`,
        title: 'PR',
        github: { owner: 'acme', repository: 'app', pullRequestNumber: pr },
      },
    }) as never;

  const explain = (text: string, executionId?: string) =>
    ({
      action: AIAction.EXPLAIN,
      text,
      ...(executionId ? { executionId } : {}),
    }) as never;

  /** Outcome of a call: 'ok' or the HTTP status / error code it failed with. */
  async function attempt(fn: () => Promise<unknown>): Promise<string> {
    try {
      await fn();
      return 'ok';
    } catch (error) {
      if (error instanceof HttpException) {
        const body = error.getResponse() as { code?: string };
        return body?.code ?? String(error.getStatus());
      }
      return (error as Error).name;
    }
  }

  const reserveFor = (ws: string, user: string, inFlight?: string) =>
    usage.reserve({
      workspaceId: ws,
      userId: user,
      metric: 'ai_action',
      operationId: randomUUID(),
      ...(inFlight ? { inFlightKey: inFlight } : {}),
    });
  const eventOf = (ws: string, key: string) =>
    prisma.workspaceUsageEvent.findUnique({
      where: { workspaceId_idempotencyKey: { workspaceId: ws, idempotencyKey: key } },
    });
  const expireLease = (ws: string, key: string) =>
    prisma.workspaceUsageEvent.updateMany({
      where: { workspaceId: ws, idempotencyKey: key },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });

  // ── 1. leases and recovery ───────────────────────────────────────────────

  it('an active operation is never recovered because of its age (its lease is renewed)', async () => {
    const { ws, user } = await seed();
    const r = await reserveFor(ws, user);
    await prisma.workspaceUsageEvent.updateMany({
      where: { workspaceId: ws, idempotencyKey: r.idempotencyKey },
      data: { createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
    });
    expect(await usage.renewLease(r)).toBe(true);
    expect(await usage.recoverExpiredReservations(ws)).toEqual({ charged: 0, refunded: 0 });
    expect((await eventOf(ws, r.idempotencyKey))?.status).toBe('reserved');
    expect(await count(ws)).toBe(1);
    expect(await usage.commit(r)).toBe(true);
    expect(await count(ws)).toBe(1);
  });

  it('a crashed operation is recovered: refunded if nothing was delivered, charged if it was', async () => {
    const { ws, user } = await seed();
    const undelivered = await reserveFor(ws, user, 'k1');
    const delivered = await reserveFor(ws, user, 'k2');
    await usage.markDelivered(delivered);
    await expireLease(ws, undelivered.idempotencyKey);
    await expireLease(ws, delivered.idempotencyKey);
    expect(await count(ws)).toBe(2);
    expect(await usage.recoverExpiredReservations(ws)).toEqual({ charged: 1, refunded: 1 });
    expect(await count(ws)).toBe(1);
    expect(await eventOf(ws, undelivered.idempotencyKey)).toBeNull();
    expect(await eventOf(ws, delivered.idempotencyKey)).toMatchObject({
      status: 'committed',
      inFlightKey: null,
    });
    // Both in-flight slots are free again.
    await expect(reserveFor(ws, user, 'k1')).resolves.toBeTruthy();
    await expect(reserveFor(ws, user, 'k2')).resolves.toBeTruthy();
  });

  it('a reservation created before leases existed is recovered by age', async () => {
    const { ws, user } = await seed();
    const r = await reserveFor(ws, user);
    await prisma.workspaceUsageEvent.updateMany({
      where: { workspaceId: ws, idempotencyKey: r.idempotencyKey },
      data: { leaseExpiresAt: null, createdAt: new Date(Date.now() - 31 * 60 * 1000) },
    });
    expect(await usage.recoverExpiredReservations(ws)).toEqual({ charged: 0, refunded: 1 });
    expect(await count(ws)).toBe(0);
  });

  it('a heartbeat that lands after the scan wins: recovery never refunds a renewed lease', async () => {
    const { ws, user } = await seed();
    const r = await reserveFor(ws, user);
    await expireLease(ws, r.idempotencyKey);
    const scanTime = new Date(Date.now() - 500); // recovery decided before the renewal
    await usage.renewLease(r);
    expect(await usage.recoverExpiredReservations(ws, scanTime)).toEqual({
      charged: 0,
      refunded: 0,
    });
    expect((await eventOf(ws, r.idempotencyKey))?.status).toBe('reserved');
  });

  it('concurrent recoveries settle each expired reservation exactly once', async () => {
    const { ws, user } = await seed();
    const rs = await Promise.all([1, 2, 3].map((i) => reserveFor(ws, user, `c${i}`)));
    await usage.markDelivered(rs[0]!);
    for (const r of rs) await expireLease(ws, r.idempotencyKey);
    const results = await Promise.all([1, 2, 3, 4].map(() => usage.recoverExpiredReservations(ws)));
    const total = results.reduce(
      (a, b) => ({ charged: a.charged + b.charged, refunded: a.refunded + b.refunded }),
      { charged: 0, refunded: 0 },
    );
    expect(total).toEqual({ charged: 1, refunded: 2 });
    expect(await count(ws)).toBe(1);
  });

  // ── 2. settlement: idempotent, concurrency-safe, never refunds delivered work ─────

  it('commit is idempotent and never charges twice', async () => {
    const { ws, user } = await seed();
    const r = await reserveFor(ws, user);
    expect(await usage.commit(r)).toBe(true);
    expect(await usage.commit(r)).toBe(true);
    expect(await count(ws)).toBe(1);
  });

  it('concurrent commit and refund: exactly one outcome, consistent counter', async () => {
    const { ws, user } = await seed();
    for (let i = 0; i < 10; i += 1) {
      const before = await count(ws);
      const r = await reserveFor(ws, user);
      const [committed, released] = await Promise.all([
        usage.commit(r),
        usage.releaseReservation(r),
      ]);
      expect(committed !== released).toBe(true);
      expect(await count(ws)).toBe(before + (committed ? 1 : 0));
    }
  });

  it('delivered work can no longer be refunded', async () => {
    const { ws, user } = await seed();
    const r = await reserveFor(ws, user);
    expect(await usage.markDelivered(r)).toBe(true);
    expect(await usage.releaseReservation(r)).toBe(false);
    expect(await count(ws)).toBe(1);
    expect(await usage.commit(r)).toBe(true);
  });

  it('a transient database failure during commit is retried: charged exactly once', async () => {
    const { ws, user } = await seed();
    const svc = service();
    const real = usage.commit.bind(usage);
    const spy = vi
      .spyOn(usage, 'commit')
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockImplementation(real);
    try {
      await svc.generateActionWithMetadata(user, explain('retry me'));
      expect(spy.mock.calls.length).toBe(2);
      expect(await count(ws)).toBe(1);
      const events = await prisma.workspaceUsageEvent.findMany({ where: { workspaceId: ws } });
      expect(events.map((e) => e.status)).toEqual(['committed']);
    } finally {
      spy.mockRestore();
    }
  });

  it('a commit that keeps failing is not silently refunded: delivery is recorded and recovery charges it', async () => {
    const { ws, user } = await seed();
    const spy = vi.spyOn(usage, 'commit').mockRejectedValue(new Error('database down'));
    let operationId: string | undefined;
    try {
      ({ operationId } = await service().generateActionWithMetadata(user, explain('delivered')));
    } finally {
      spy.mockRestore();
    }
    const key = `op:${operationId}`;
    expect(await eventOf(ws, key)).toMatchObject({ status: 'reserved' });
    expect((await eventOf(ws, key))?.deliveredAt).not.toBeNull();
    // The process "stops heartbeating"; recovery finds a delivered operation and charges it.
    await expireLease(ws, key);
    expect(await usage.recoverExpiredReservations(ws)).toEqual({ charged: 1, refunded: 0 });
    expect(await count(ws)).toBe(1);
  });

  // ── 3. retries ───────────────────────────────────────────────────────────

  it('a lost-response retry replays the completed result: no model call, no new charge', async () => {
    const { ws, user } = await seed();
    const first = await service().generateActionWithMetadata(user, review(3));
    expect(first.operationId).toMatch(/^[0-9a-f-]{36}$/);
    const calls = modelCalls();
    const again = await service().generateActionWithMetadata(user, {
      ...(review(3) as object),
      retryOperationId: first.operationId,
    } as never);
    expect(again).toMatchObject({
      text: first.text,
      replayed: true,
      operationId: first.operationId,
    });
    expect(again.coverage).toEqual(JSON.parse(JSON.stringify(first.coverage)));
    expect(modelCalls()).toBe(calls);
    expect(await count(ws)).toBe(1);

    const std = await service().generateActionWithMetadata(user, explain('q'));
    const stdAgain = await service().generateActionWithMetadata(user, {
      ...(explain('q') as object),
      retryOperationId: std.operationId,
    } as never);
    expect(stdAgain).toMatchObject({ text: std.text, replayed: true });
    expect(await count(ws)).toBe(2);
  });

  it('a retry id never bypasses quota: other user, other request, unknown or expired ids run as new charged operations', async () => {
    const ws = await seedWorkspace();
    const alice = await seedUser(ws);
    const bob = await seedUser(ws);
    const done = await service().generateActionWithMetadata(alice, review(4));
    expect(await count(ws)).toBe(1);
    const retry = (user: string, pr: number, id: string) =>
      service().generateActionWithMetadata(user, {
        ...(review(pr) as object),
        retryOperationId: id,
      } as never);

    expect((await retry(bob, 4, done.operationId!)).replayed).toBeUndefined(); // other user
    expect((await retry(alice, 5, done.operationId!)).replayed).toBeUndefined(); // other request
    expect((await retry(alice, 4, randomUUID())).replayed).toBeUndefined(); // unknown id
    await prisma.workspaceUsageEvent.updateMany({
      where: { workspaceId: ws, idempotencyKey: `op:${done.operationId}` },
      data: { resultExpiresAt: new Date(Date.now() - 1_000) },
    });
    expect((await retry(alice, 4, done.operationId!)).replayed).toBeUndefined(); // expired
    expect(await count(ws)).toBe(5);

    // With the quota exhausted, a non-matching retry id is refused like any new request.
    await exhaust(ws);
    expect(await attempt(() => retry(bob, 4, done.operationId!))).toBe('USAGE_LIMIT_REACHED');
  });

  it('a retry while the original is still running is a duplicate (409), not a second run', async () => {
    const { ws, user } = await seed();
    let release!: () => void;
    generateTextMock.mockImplementation(
      () => new Promise((resolve) => (release = () => resolve(answer()))),
    );
    const firstRun = service().generateActionWithMetadata(user, review(6));
    await vi.waitFor(() => expect(generateTextMock).toHaveBeenCalled());
    const opId = (await prisma.workspaceUsageEvent.findFirst({
      where: { workspaceId: ws, status: 'reserved' },
    }))!.idempotencyKey.replace(/^op:/, '');
    expect(
      await attempt(() =>
        service().generateActionWithMetadata(user, {
          ...(review(6) as object),
          retryOperationId: opId,
        } as never),
      ),
    ).toBe('AI_OPERATION_IN_PROGRESS');
    release();
    await firstRun;
    expect(modelCalls()).toBe(1);
    expect(await count(ws)).toBe(1);
  });

  it('a retry after a failed operation runs again and is charged once', async () => {
    const { ws, user } = await seed();
    generateTextMock.mockRejectedValue(new Error('provider down'));
    expect(await attempt(() => service().generateActionWithMetadata(user, review(8)))).not.toBe(
      'ok',
    );
    expect(await count(ws)).toBe(0);
    const failedId = (await prisma.workspaceUsageEvent.findMany({ where: { workspaceId: ws } }))
      .length;
    expect(failedId).toBe(0); // the failed operation left nothing to replay
    generateTextMock.mockReset().mockImplementation(async () => answer());
    const ok = await service().generateActionWithMetadata(user, {
      ...(review(8) as object),
      retryOperationId: randomUUID(),
    } as never);
    expect(ok.replayed).toBeUndefined();
    expect(await count(ws)).toBe(1);
  });

  // ── 4. subscription status → entitlements (current policy) ────────────────

  it('a cancelled paid subscription falls back to the free AI quota', async () => {
    const { ws, user } = await seed();
    await prisma.workspaceSubscription.update({
      where: { workspaceId: ws },
      data: { status: 'cancelled' },
    });
    await prisma.workspaceUsageCounter.create({
      data: { workspaceId: ws, metric: 'ai_action', periodKey: usagePeriodKey(), count: 50 },
    });
    expect(await attempt(() => service().generateActionWithMetadata(user, explain('x')))).toBe(
      'USAGE_LIMIT_REACHED',
    );
    expect(modelCalls()).toBe(0);
  });

  it('past_due keeps the paid quota (dunning); paused keeps it too (undecided policy, unchanged)', async () => {
    for (const status of ['past_due', 'paused']) {
      const { ws, user } = await seed();
      await prisma.workspaceSubscription.update({ where: { workspaceId: ws }, data: { status } });
      await prisma.workspaceUsageCounter.create({
        data: { workspaceId: ws, metric: 'ai_action', periodKey: usagePeriodKey(), count: 50 },
      });
      expect(await attempt(() => service().generateActionWithMetadata(user, explain(status)))).toBe(
        'ok',
      );
    }
  });

  // ── beta-readiness additions ─────────────────────────────────────────────

  it('a stored result is replayed once, then erased (a second retry is a new operation)', async () => {
    const { ws, user } = await seed();
    const first = await service().generateActionWithMetadata(user, explain('once'));
    const retry = () =>
      service().generateActionWithMetadata(user, {
        ...(explain('once') as object),
        retryOperationId: first.operationId,
      } as never);
    expect((await retry()).replayed).toBe(true);
    const row = await eventOf(ws, `op:${first.operationId}`);
    expect(row).toMatchObject({ resultText: null, resultExpiresAt: null });
    expect((await retry()).replayed).toBeUndefined();
    expect(await count(ws)).toBe(2);
  });

  it('output the caller rejects (validate throws) is refunded', async () => {
    const { ws, user } = await seed();
    await expect(
      service().generateActionWithMetadata(user, explain('bad json'), {
        validate: () => {
          throw new Error('not the structured result');
        },
      }),
    ).rejects.toThrow('not the structured result');
    expect(await count(ws)).toBe(0);
    expect(await prisma.workspaceUsageEvent.count({ where: { workspaceId: ws } })).toBe(0);
  });

  // ── F-06 / F-07: provider work already done, nothing usable delivered ────

  const refundBudgetUsed = async (ws: string) =>
    (
      await prisma.workspaceUsageCounter.findFirst({
        where: { workspaceId: ws, metric: { startsWith: 'provider_work_refund:' } },
      })
    )?.count ?? 0;

  function fakeResponse() {
    const written: string[] = [];
    return {
      written,
      statusCode: 0,
      writableEnded: false,
      headersSent: false,
      setHeader: () => undefined,
      flushHeaders: () => undefined,
      write(chunk: string) {
        written.push(String(chunk));
        return true;
      },
      end() {
        this.writableEnded = true;
      },
    };
  }

  /**
   * Starts a streamed PR review and hangs up at a chosen point — deterministically: the model
   * double reports "call started" and then waits until the test has aborted the request.
   */
  async function cancelledReview(user: string, pr: number, when: 'before_model' | 'during_model') {
    let started!: () => void;
    const modelStarted = new Promise<void>((resolve) => (started = resolve));
    let release!: () => void;
    const mayReturn = new Promise<void>((resolve) => (release = resolve));
    generateTextMock
      .mockReset()
      .mockImplementation(async (options: { abortSignal?: AbortSignal }) => {
        started();
        await mayReturn;
        if (options.abortSignal?.aborted) throw new DOMException('aborted', 'AbortError');
        return answer();
      });
    const controller = new AbortController();
    const response = fakeResponse();
    if (when === 'before_model') controller.abort();
    const done = service().pipeActionStream(user, review(pr), response as never, controller.signal);
    if (when === 'during_model') {
      await modelStarted;
      controller.abort();
    }
    release();
    await done;
    return response;
  }

  it('[F-06] a review cancelled AFTER model calls started is refunded only within the per-period budget', async () => {
    const { ws, user } = await seed();
    for (let i = 1; i <= PROVIDER_WORK_REFUNDS_PER_PERIOD; i += 1) {
      const response = await cancelledReview(user, 100 + i, 'during_model');
      expect(modelCalls()).toBeGreaterThan(0);
      expect(response.written.join('').trim()).toBe(''); // no review text was delivered
      expect(await count(ws)).toBe(0);
      expect(await refundBudgetUsed(ws)).toBe(i);
    }
    // The budget is spent: hanging up no longer makes the provider work free.
    await cancelledReview(user, 200, 'during_model');
    expect(await count(ws)).toBe(1);
    await cancelledReview(user, 201, 'during_model');
    expect(await count(ws)).toBe(2);
    expect(await refundBudgetUsed(ws)).toBe(PROVIDER_WORK_REFUNDS_PER_PERIOD);
    // Charged operations are final and hold no in-flight slot (the same PR can be reviewed).
    const events = await prisma.workspaceUsageEvent.findMany({ where: { workspaceId: ws } });
    expect(events.map((e) => e.status)).toEqual(['committed', 'committed']);
    expect(events.every((e) => e.inFlightKey === null)).toBe(true);
  });

  it('[F-06] a review cancelled BEFORE any model call is a plain refund (no budget used, never charged)', async () => {
    const { ws, user } = await seed();
    for (let i = 0; i < PROVIDER_WORK_REFUNDS_PER_PERIOD + 3; i += 1) {
      await cancelledReview(user, 300 + i, 'before_model');
    }
    expect(modelCalls()).toBe(0);
    expect(await count(ws)).toBe(0);
    expect(await refundBudgetUsed(ws)).toBe(0);
    expect(await prisma.workspaceUsageEvent.count({ where: { workspaceId: ws } })).toBe(0);
  });

  it('[F-06] the budget is per user: another member is unaffected', async () => {
    const { ws, user } = await seed();
    const other = await seedUser(ws);
    for (let i = 0; i <= PROVIDER_WORK_REFUNDS_PER_PERIOD; i += 1) {
      await cancelledReview(user, 400 + i, 'during_model');
    }
    expect(await count(ws)).toBe(1);
    await cancelledReview(other, 500, 'during_model');
    expect(await count(ws)).toBe(1); // other's first cancellation is within their own budget
  });

  it('[F-07] unusable model output is refunded within the budget, then charged', async () => {
    const { ws, user } = await seed();
    const rejected = (n: number) =>
      attempt(() =>
        service().generateActionWithMetadata(user, explain(`bad json ${n}`), {
          validate: () => {
            throw new Error('not the structured result');
          },
        }),
      );
    const total = PROVIDER_WORK_REFUNDS_PER_PERIOD + 4;
    for (let n = 0; n < total; n += 1) expect(await rejected(n)).toBe('Error');
    expect(modelCalls()).toBe(total); // every attempt reached the provider
    expect(await count(ws)).toBe(4); // …and beyond the budget each one cost a unit
  });

  it('[F-07] concurrent unusable results cannot overspend the refund budget', async () => {
    const { ws, user } = await seed();
    const total = PROVIDER_WORK_REFUNDS_PER_PERIOD + 5;
    await Promise.all(
      Array.from({ length: total }, (_, n) =>
        attempt(() =>
          service().generateActionWithMetadata(user, explain(`parallel ${n}`), {
            validate: () => {
              throw new Error('unusable');
            },
          }),
        ),
      ),
    );
    expect(await refundBudgetUsed(ws)).toBe(PROVIDER_WORK_REFUNDS_PER_PERIOD);
    expect(await count(ws)).toBe(5);
  });

  it('a provider failure (no usable work) is still a plain refund', async () => {
    const { ws, user } = await seed();
    generateTextMock.mockReset().mockRejectedValue(new Error('provider 503'));
    for (let n = 0; n < PROVIDER_WORK_REFUNDS_PER_PERIOD + 2; n += 1) {
      await attempt(() => service().generateActionWithMetadata(user, explain(`down ${n}`)));
    }
    expect(await count(ws)).toBe(0);
    expect(await refundBudgetUsed(ws)).toBe(0);
  });

  it('the maintenance sweep recovers idle workspaces and erases expired result copies', async () => {
    const { ws, user } = await seed();
    const done = await service().generateActionWithMetadata(user, explain('keep briefly'));
    // Then a process crashes and the workspace goes idle (no request runs a lazy recovery).
    const crashed = await reserveFor(ws, user);
    await expireLease(ws, crashed.idempotencyKey);
    await prisma.workspaceUsageEvent.updateMany({
      where: { workspaceId: ws, idempotencyKey: `op:${done.operationId}` },
      data: { resultExpiresAt: new Date(Date.now() - 1_000) },
    });
    const out = await usage.sweep();
    expect(out.workspaces).toBeGreaterThanOrEqual(1);
    expect(await eventOf(ws, crashed.idempotencyKey)).toBeNull();
    expect(await eventOf(ws, `op:${done.operationId}`)).toMatchObject({
      status: 'committed',
      resultText: null,
    });
    expect(await count(ws)).toBe(1);
  });
});
