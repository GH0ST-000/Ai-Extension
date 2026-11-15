/**
 * PR review usage accounting on PostgreSQL (Private Beta QA).
 *
 * Real: PrismaClient/PostgreSQL, UsageService, EntitlementService, FeatureGate, workspace
 * resolution, planner, orchestrator, finding validation. Stubbed: the model
 * (`ai.generateText`), the GitHub diff (already-normalized files), settings, observability.
 * Run via `pnpm --filter @project-x/api test:integration`.
 */
import { ServiceUnavailableException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { APICallError } from 'ai';
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
const ok = () => ({
  output: { summary: 'fine', findings: [] },
  finishReason: 'stop',
  usage: { inputTokens: 800, outputTokens: 60, totalTokens: 860 },
});
const transient = () =>
  new APICallError({
    message: 'busy',
    url: 'u',
    requestBodyValues: {},
    statusCode: 503,
    isRetryable: true,
  });

describe.skipIf(!URL_ENV)('PR review usage accounting on PostgreSQL', () => {
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
    generateTextMock.mockReset().mockImplementation(async () => ok());
    diff.resolve.mockReset();
  });

  async function seed() {
    run += 1;
    const ws = `ws_usage_${run}_${Date.now()}`;
    const user = `usage_user_${run}_${Date.now()}`;
    await prisma.workspace.create({ data: { id: ws, name: ws, slug: ws } });
    await prisma.workspaceSubscription.create({
      data: { workspaceId: ws, provider: 'paddle', planId: 'pro', status: 'active' },
    });
    await prisma.user.create({
      data: { id: user, email: `${user}@it.test`, passwordHash: 'x', lastWorkspaceId: ws },
    });
    await prisma.workspaceMembership.create({
      data: { workspaceId: ws, userId: user, role: 'owner', status: 'active' },
    });
    return { ws, user };
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
          prReview: {
            maxOutputTokens: 2_000,
            requestTimeoutMs: 30_000,
            maxBatches: 6,
            concurrency: 3,
            batchInputTokens: 16_000,
            maxInputTokens: 96_000,
            maxTotalOutputTokens: 12_000,
            reviewTimeoutMs: 60_000,
          },
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

  const input = {
    action: AIAction.REVIEW_ENTIRE_PR,
    text: 'Review this PR.',
    context: {
      type: 'github',
      url: 'https://github.com/acme/app/pull/1',
      title: 'PR',
      github: { owner: 'acme', repository: 'app', pullRequestNumber: 1 },
    },
  } as never;
  const manyFiles = () =>
    Array.from({ length: 40 }, (_, i) =>
      makeFile(`src/f${i}.ts`, makePatch(55, { tag: `f${i}_` })),
    );

  // ── UsageService primitives ──────────────────────────────────────────────

  it('consume is idempotent per key; release undoes exactly one charge and is idempotent', async () => {
    const { ws } = await seed();
    await usage.consume({ workspaceId: ws, metric: 'ai_action', idempotencyKey: 'k1' });
    const dup = await usage.consume({ workspaceId: ws, metric: 'ai_action', idempotencyKey: 'k1' });
    expect(dup.duplicate).toBe(true);
    expect(await count(ws)).toBe(1);

    expect(
      await usage.release({ workspaceId: ws, metric: 'ai_action', idempotencyKey: 'k1' }),
    ).toBe(true);
    expect(await count(ws)).toBe(0);
    expect(
      await usage.release({ workspaceId: ws, metric: 'ai_action', idempotencyKey: 'k1' }),
    ).toBe(false);
    expect(await count(ws)).toBe(0);
  });

  it('release never drives a counter negative and is scoped to its workspace', async () => {
    const a = await seed();
    const b = await seed();
    await usage.consume({ workspaceId: a.ws, metric: 'ai_action', idempotencyKey: 'shared-key' });
    // Same key in another workspace releases nothing in A.
    expect(
      await usage.release({ workspaceId: b.ws, metric: 'ai_action', idempotencyKey: 'shared-key' }),
    ).toBe(false);
    expect(await count(a.ws)).toBe(1);

    await prisma.workspaceUsageCounter.updateMany({
      where: { workspaceId: a.ws },
      data: { count: 0 },
    });
    expect(
      await usage.release({ workspaceId: a.ws, metric: 'ai_action', idempotencyKey: 'shared-key' }),
    ).toBe(true);
    expect(await count(a.ws)).toBe(0);
  });

  // ── end-to-end PR review accounting ──────────────────────────────────────

  it('a multi-batch review with an internal retry charges exactly one unit', async () => {
    const { ws, user } = await seed();
    diff.resolve.mockResolvedValue({ source: 'github_api', files: manyFiles(), totalFiles: 40 });
    generateTextMock.mockRejectedValueOnce(transient());
    const result = await service().generateActionWithMetadata(user, input);
    expect(generateTextMock.mock.calls.length).toBe(result.coverage!.batches.length + 1);
    expect(result.coverage!.batches.length).toBeGreaterThan(1);
    expect(await count(ws)).toBe(1);
  });

  it('a partially failed review is charged once and reported partial', async () => {
    const { ws, user } = await seed();
    diff.resolve.mockResolvedValue({ source: 'github_api', files: manyFiles(), totalFiles: 40 });
    // The batch holding src/f0.ts fails on both attempts (there is no third attempt).
    generateTextMock.mockImplementation(async (args: { messages: { content: string }[] }) => {
      if (args.messages[0]!.content.includes('### file: src/f0.ts\n')) throw transient();
      return ok();
    });
    const result = await service().generateActionWithMetadata(user, input);
    expect(result.coverage!.batches.filter((b) => b.status === 'failed')).toHaveLength(1);
    expect(result.coverage!.complete).toBe(false);
    expect(result.coverage!.riskLevel).not.toBe('low');
    expect(await count(ws)).toBe(1);
  });

  it('a review where every batch fails is not charged (503, unit released)', async () => {
    const { ws, user } = await seed();
    diff.resolve.mockResolvedValue({
      source: 'github_api',
      files: [makeFile('src/a.ts', makePatch(5))],
      totalFiles: 1,
    });
    generateTextMock.mockRejectedValue(transient());
    await expect(service().generateActionWithMetadata(user, input)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(generateTextMock).toHaveBeenCalledTimes(2);
    expect(await count(ws)).toBe(0);
    expect(await prisma.workspaceUsageEvent.count({ where: { workspaceId: ws } })).toBe(0);

    // The user retries: charged once for the successful review only.
    generateTextMock.mockReset().mockImplementation(async () => ok());
    await service().generateActionWithMetadata(user, input);
    expect(await count(ws)).toBe(1);
  });

  it('a review with nothing reviewable makes no AI call and is not charged', async () => {
    const { ws, user } = await seed();
    diff.resolve.mockResolvedValue({
      source: 'github_api',
      files: [makeFile('pnpm-lock.yaml', makePatch(3))],
      totalFiles: 1,
    });
    const result = await service().generateActionWithMetadata(user, input);
    expect(generateTextMock).not.toHaveBeenCalled();
    expect(result.coverage!.usageUnits).toBe(0);
    expect(await count(ws)).toBe(0);
  });
});
