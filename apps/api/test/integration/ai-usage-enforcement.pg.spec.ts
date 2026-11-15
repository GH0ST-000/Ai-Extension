/**
 * AI usage enforcement on PostgreSQL: every model execution must be backed by an authorized,
 * correctly accounted usage charge that the SERVER controls. Client-supplied `executionId`
 * values are linkage metadata only and never prove a previous charge.
 *
 * Real: PrismaClient/PostgreSQL, UsageService, EntitlementService, FeatureGate, workspace
 * resolution, PR planner and orchestrator. Stubbed: the model (`ai.generateText`) and the
 * GitHub diff. Run via `pnpm --filter @project-x/api test:integration`.
 */
import { HttpException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { usagePeriodKey } from '@project-x/shared';
import { AIAction } from '@project-x/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiService } from '../../src/ai/ai.service';
import { makeFile, makePatch } from '../../src/ai/pr-review/pr-review-fixtures';
import { PrReviewOrchestrator } from '../../src/ai/pr-review/pr-review-orchestrator.service';
import { PromptRegistry } from '../../src/ai/prompts/prompt.registry';
import { EntitlementService } from '../../src/entitlements/entitlements.service';
import { FeatureGate } from '../../src/entitlements/feature-gate';
import { UsageService } from '../../src/usage/usage.service';

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

describe.skipIf(!URL_ENV)('AI usage enforcement on PostgreSQL', () => {
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
    const ws = `ws_enf_${run}_${Date.now()}`;
    await prisma.workspace.create({ data: { id: ws, name: ws, slug: ws } });
    await prisma.workspaceSubscription.create({
      data: { workspaceId: ws, provider: 'paddle', planId: 'pro', status: 'active' },
    });
    return ws;
  }

  async function seedUser(ws: string) {
    run += 1;
    const user = `enf_user_${run}_${Date.now()}`;
    await prisma.user.create({
      data: { id: user, email: `${user}@it.test`, passwordHash: 'x', lastWorkspaceId: ws },
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

  // ── client-supplied executionId is never proof of a charge ───────────────

  it('reusing an executionId for a DIFFERENT PR review charges again (no free review)', async () => {
    const { ws, user } = await seed();
    await service().generateActionWithMetadata(user, review(1, 'exec-reused'));
    const afterFirst = modelCalls();
    await service().generateActionWithMetadata(user, review(2, 'exec-reused'));
    expect(modelCalls()).toBeGreaterThan(afterFirst); // the second review ran …
    expect(await count(ws)).toBe(2); // … and was charged
  });

  it('repeating a completed review with the same executionId is charged again (never free)', async () => {
    const { ws, user } = await seed();
    await service().generateActionWithMetadata(user, review(1, 'exec-repeat'));
    await service().generateActionWithMetadata(user, review(1, 'exec-repeat'));
    expect(await count(ws)).toBe(2);
  });

  it('an exhausted quota blocks the review even with a previously charged executionId', async () => {
    const { ws, user } = await seed();
    await service().generateActionWithMetadata(user, review(1, 'exec-quota'));
    await exhaust(ws);
    const before = modelCalls();
    expect(
      await attempt(() => service().generateActionWithMetadata(user, review(2, 'exec-quota'))),
    ).toBe('USAGE_LIMIT_REACHED');
    expect(modelCalls()).toBe(before); // no model execution
    expect(await count(ws)).toBe(PRO_LIMIT);
  });

  it('standard AI actions: an exhausted quota blocks execution even with a reused executionId', async () => {
    const { ws, user } = await seed();
    await service().generateActionWithMetadata(user, explain('first', 'exec-std'));
    expect(await count(ws)).toBe(1);
    await exhaust(ws);
    const before = modelCalls();
    expect(
      await attempt(() =>
        service().generateActionWithMetadata(user, explain('second', 'exec-std')),
      ),
    ).toBe('USAGE_LIMIT_REACHED');
    expect(modelCalls()).toBe(before);
  });

  it('cross-user: another member cannot ride on a teammate executionId', async () => {
    const ws = await seedWorkspace();
    const alice = await seedUser(ws);
    const bob = await seedUser(ws);
    await service().generateActionWithMetadata(alice, review(1, 'exec-alice'));
    await service().generateActionWithMetadata(bob, review(1, 'exec-alice'));
    expect(await count(ws)).toBe(2);
  });

  it('cross-workspace: the same executionId in another workspace is charged there', async () => {
    const a = await seed();
    const b = await seed();
    await service().generateActionWithMetadata(a.user, review(1, 'exec-shared'));
    await service().generateActionWithMetadata(b.user, review(1, 'exec-shared'));
    expect(await count(a.ws)).toBe(1);
    expect(await count(b.ws)).toBe(1);
  });

  // ── concurrency ──────────────────────────────────────────────────────────

  it('concurrent requests with the same executionId: every model execution is charged', async () => {
    const { ws, user } = await seed();
    let executed = 0;
    generateTextMock.mockImplementation(async () => {
      executed += 1;
      await new Promise((r) => setTimeout(r, 30));
      return answer();
    });
    const outcomes = await Promise.all(
      [1, 2, 3].map(() =>
        attempt(() => service().generateActionWithMetadata(user, review(1, 'exec-concurrent'))),
      ),
    );
    const reviewsRun = outcomes.filter((o) => o === 'ok').length;
    expect(reviewsRun).toBeGreaterThanOrEqual(1);
    // Each review makes one batch call here: executions == charges.
    expect(executed).toBe(reviewsRun);
    expect(await count(ws)).toBe(reviewsRun);
  });

  it('concurrent distinct requests never exceed the plan limit', async () => {
    const { ws, user } = await seed();
    await exhaust(ws);
    await prisma.workspaceUsageCounter.updateMany({
      where: { workspaceId: ws },
      data: { count: PRO_LIMIT - 2 },
    });
    const outcomes = await Promise.all(
      [1, 2, 3, 4, 5, 6].map((i) =>
        attempt(() => service().generateActionWithMetadata(user, explain(`q${i}`))),
      ),
    );
    expect(outcomes.filter((o) => o === 'ok')).toHaveLength(2);
    expect(outcomes.filter((o) => o === 'USAGE_LIMIT_REACHED')).toHaveLength(4);
    expect(await count(ws)).toBe(PRO_LIMIT);
    expect(modelCalls()).toBe(2);
  });

  it('identical concurrent PR reviews by one user run the model once (no duplicate execution)', async () => {
    const { ws, user } = await seed();
    generateTextMock.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return answer();
    });
    const outcomes = await Promise.all(
      [1, 2].map(() => attempt(() => service().generateActionWithMetadata(user, review(7)))),
    );
    expect(outcomes.sort()).toEqual(['AI_OPERATION_IN_PROGRESS', 'ok']);
    expect(modelCalls()).toBe(1);
    expect(await count(ws)).toBe(1);
  });

  // ── failures and refunds ─────────────────────────────────────────────────

  it('a failed standard action is not charged (refunded), and a retry is charged once', async () => {
    const { ws, user } = await seed();
    generateTextMock.mockRejectedValueOnce(new Error('provider down'));
    expect(await attempt(() => service().generateActionWithMetadata(user, explain('x')))).not.toBe(
      'ok',
    );
    expect(await count(ws)).toBe(0);
    await service().generateActionWithMetadata(user, explain('x'));
    expect(await count(ws)).toBe(1);
  });

  it('an unexpected orchestrator crash refunds the PR review charge', async () => {
    const { ws, user } = await seed();
    const svc = service();
    const orchestrator = (svc as unknown as { prReviewOrchestrator: PrReviewOrchestrator })
      .prReviewOrchestrator;
    vi.spyOn(orchestrator, 'run').mockRejectedValueOnce(new TypeError('boom'));
    expect(await attempt(() => svc.generateActionWithMetadata(user, review(1)))).not.toBe('ok');
    expect(await count(ws)).toBe(0);
    expect(await prisma.workspaceUsageEvent.count({ where: { workspaceId: ws } })).toBe(0);
  });

  it('a partially completed review is charged exactly once', async () => {
    const { ws, user } = await seed();
    diff.resolve.mockResolvedValue({
      source: 'github_api',
      files: Array.from({ length: 40 }, (_, i) =>
        makeFile(`src/f${i}.ts`, makePatch(55, { tag: `f${i}_` })),
      ),
      totalFiles: 40,
    });
    generateTextMock.mockImplementation(async (args: { messages: { content: string }[] }) => {
      if (args.messages[0]!.content.includes('### file: src/f0.ts\n')) throw new Error('fail');
      return answer();
    });
    const result = await service().generateActionWithMetadata(user, review(1));
    expect(result.coverage!.complete).toBe(false);
    expect(await count(ws)).toBe(1);
  });

  // ── reservation lifecycle ────────────────────────────────────────────────

  const reserveFor = (ws: string, user: string, operationId: string, inFlight?: string) =>
    usage.reserve({
      workspaceId: ws,
      userId: user,
      metric: 'ai_action',
      operationId,
      ...(inFlight ? { inFlightKey: inFlight } : {}),
    });

  it('an abandoned reservation (crashed process, lease expired) is refunded; a fresh one is not', async () => {
    const { ws, user } = await seed();
    const abandoned = await reserveFor(ws, user, `crash-${ws}`, 'same-op');
    expect(await count(ws)).toBe(1);
    // A second identical operation is blocked while the first is (apparently) running.
    await expect(reserveFor(ws, user, `retry-${ws}`, 'same-op')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'AI_OPERATION_IN_PROGRESS' }),
    });
    await prisma.workspaceUsageEvent.updateMany({
      where: { workspaceId: ws, idempotencyKey: abandoned.idempotencyKey },
      // The crashed process stopped renewing its lease.
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });
    // The next reservation recovers it: refunded, and the identical operation can run again.
    const next = await reserveFor(ws, user, `retry2-${ws}`, 'same-op');
    expect(await count(ws)).toBe(1);
    expect(
      await prisma.workspaceUsageEvent.count({
        where: { workspaceId: ws, idempotencyKey: abandoned.idempotencyKey },
      }),
    ).toBe(0);
    // A late commit of the recovered reservation charges nothing.
    expect(await usage.commit(abandoned)).toBe(false);
    expect(await usage.commit(next)).toBe(true);
    expect(await count(ws)).toBe(1);
  });

  it('commit frees the in-flight slot; a committed charge is never refunded by releaseReservation', async () => {
    const { ws, user } = await seed();
    const first = await reserveFor(ws, user, `a-${ws}`, 'op');
    expect(await usage.commit(first)).toBe(true);
    expect(await usage.releaseReservation(first)).toBe(false);
    expect(await count(ws)).toBe(1);
    const second = await reserveFor(ws, user, `b-${ws}`, 'op');
    expect(await usage.commit(second)).toBe(true);
    expect(await count(ws)).toBe(2);
  });

  it('concurrent releases of one reservation refund exactly once', async () => {
    const { ws, user } = await seed();
    await prisma.workspaceUsageCounter.create({
      data: { workspaceId: ws, metric: 'ai_action', periodKey: usagePeriodKey(), count: 3 },
    });
    const r = await reserveFor(ws, user, `rel-${ws}`);
    expect(await count(ws)).toBe(4);
    const results = await Promise.all([1, 2, 3, 4].map(() => usage.releaseReservation(r)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await count(ws)).toBe(3);
  });

  it('the same in-flight key of another user, or of another workspace, does not block', async () => {
    const ws = await seedWorkspace();
    const alice = await seedUser(ws);
    const bob = await seedUser(ws);
    await reserveFor(ws, alice, `x-${ws}`, 'k-alice');
    // AiService binds the key to the user, so two users never share it; distinct keys pass.
    await expect(reserveFor(ws, bob, `y-${ws}`, 'k-bob')).resolves.toBeTruthy();
    const other = await seed();
    await expect(reserveFor(other.ws, other.user, `z-${ws}`, 'k-alice')).resolves.toBeTruthy();
  });
});
