/**
 * Decision 1 on PostgreSQL: free AI quota requires a verified email — for the acting user and
 * for the workspace owner(s). Enforced in UsageService.reserve (the single gate every model
 * execution passes: standard actions, Entire PR review, selection review, CI analysis and
 * workflow planning), before any quota write and before any model call.
 *
 * Real: PrismaClient/PostgreSQL, UsageService, EntitlementService, FeatureGate, workspace
 * resolution, PR planner/orchestrator, EmailVerificationService.confirm. Stubbed: the model
 * (`ai.generateText`) and the GitHub diff.
 */
import { HttpException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { usagePeriodKey } from '@project-x/shared';
import { AIAction } from '@project-x/types';
import { randomBytes, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiService } from '../../src/ai/ai.service';
import { makeFile, makePatch } from '../../src/ai/pr-review/pr-review-fixtures';
import { PrReviewOrchestrator } from '../../src/ai/pr-review/pr-review-orchestrator.service';
import { PromptRegistry } from '../../src/ai/prompts/prompt.registry';
import { EntitlementService } from '../../src/entitlements/entitlements.service';
import { FeatureGate } from '../../src/entitlements/feature-gate';
import { UsageService } from '../../src/usage/usage.service';
import {
  EmailVerificationService,
  hashVerificationToken,
} from '../../src/auth/email-verification.service';

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
const answer = () => ({
  text: 'An answer.',
  output: { summary: 'fine', findings: [] },
  finishReason: 'stop',
  usage: { inputTokens: 800, outputTokens: 60, totalTokens: 860 },
});

describe.skipIf(!URL_ENV)('Free AI requires a verified email (Decision 1, PostgreSQL)', () => {
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

  async function seedWorkspace(planId: 'free' | 'pro' = 'free') {
    run += 1;
    const ws = `ws_fav_${run}_${Date.now()}`;
    await prisma.workspace.create({ data: { id: ws, name: ws, slug: ws } });
    await prisma.workspaceSubscription.create({
      data: {
        workspaceId: ws,
        provider: 'paddle',
        planId,
        status: planId === 'free' ? 'none' : 'active',
      },
    });
    return ws;
  }

  async function seedUser(
    ws: string,
    opts: { verified: boolean; role?: 'owner' | 'member' } = { verified: false },
  ) {
    run += 1;
    const user = `fav_user_${run}_${Date.now()}`;
    await prisma.user.create({
      data: {
        id: user,
        email: `${user}@it.test`,
        passwordHash: 'x',
        lastWorkspaceId: ws,
        emailVerifiedAt: opts.verified ? new Date() : null,
      },
    });
    await prisma.workspaceMembership.create({
      data: { workspaceId: ws, userId: user, role: opts.role ?? 'owner', status: 'active' },
    });
    return user;
  }

  async function seed(planId: 'free' | 'pro' = 'free', verified = false) {
    const ws = await seedWorkspace(planId);
    return { ws, user: await seedUser(ws, { verified }) };
  }

  const events = (ws: string) => prisma.workspaceUsageEvent.count({ where: { workspaceId: ws } });

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

  const selectReview = (text: string) =>
    ({
      action: AIAction.REVIEW_CODE,
      text,
      context: { type: 'github', url: 'https://github.com/acme/app/pull/1', title: 'PR' },
    }) as never;
  const workflow = (text: string) => ({ action: AIAction.PLAN_DEVELOPER_WORKFLOW, text }) as never;

  async function statusOf(fn: () => Promise<unknown>): Promise<number | 'ok'> {
    try {
      await fn();
      return 'ok';
    } catch (error) {
      return error instanceof HttpException ? error.getStatus() : -1;
    }
  }

  // ── rejection: before quota, before the model ─────────────────────────────

  it('unverified free account: every AI path is refused with 403 EMAIL_VERIFICATION_REQUIRED, no quota, no model call', async () => {
    const { ws, user } = await seed('free', false);
    const outcomes = {
      explain: await attempt(() => service().generateActionWithMetadata(user, explain('x'))),
      selection: await attempt(() =>
        service().generateActionWithMetadata(user, selectReview('const a = 1;')),
      ),
      entirePr: await attempt(() => service().generateActionWithMetadata(user, review(11))),
      // Not on the free plan at all: refused by the plan's feature gate even earlier.
      workflow: await attempt(() => service().generateActionWithMetadata(user, workflow('plan'))),
    };
    expect(outcomes).toEqual({
      explain: 'EMAIL_VERIFICATION_REQUIRED',
      selection: 'EMAIL_VERIFICATION_REQUIRED',
      entirePr: 'EMAIL_VERIFICATION_REQUIRED',
      workflow: 'FEATURE_NOT_AVAILABLE',
    });
    expect(await statusOf(() => service().generateActionWithMetadata(user, explain('y')))).toBe(
      403,
    );
    expect(modelCalls()).toBe(0);
    expect(await count(ws)).toBe(0);
    expect(await events(ws)).toBe(0);
    const workflowRow = await prisma.workspaceUsageCounter.findFirst({
      where: { workspaceId: ws, metric: 'workflow_run' },
    });
    expect(workflowRow?.count ?? 0).toBe(0);
  });

  it('verified free account is allowed and charged normally', async () => {
    const { ws, user } = await seed('free', true);
    expect(await attempt(() => service().generateActionWithMetadata(user, explain('x')))).toBe(
      'ok',
    );
    expect(modelCalls()).toBe(1);
    expect(await count(ws)).toBe(1);
  });

  it('paid workspaces keep their behaviour: an unverified member of a Pro workspace is not gated', async () => {
    const { ws, user } = await seed('pro', false);
    expect(await attempt(() => service().generateActionWithMetadata(user, explain('x')))).toBe(
      'ok',
    );
    expect(await count(ws)).toBe(1);
  });

  it('unverified workspace OWNER: a verified member cannot spend that free pool (multiplication path)', async () => {
    const ws = await seedWorkspace('free');
    await seedUser(ws, { verified: false, role: 'owner' }); // throwaway, never verified
    const member = await seedUser(ws, { verified: true, role: 'member' });
    expect(await attempt(() => service().generateActionWithMetadata(member, explain('x')))).toBe(
      'EMAIL_VERIFICATION_REQUIRED',
    );
    const error = await service()
      .generateActionWithMetadata(member, explain('x'))
      .catch((e: HttpException) => e.getResponse() as Record<string, unknown>);
    expect(error).toMatchObject({ details: { reason: 'workspace_owner' } });
    expect(JSON.stringify(error)).not.toContain('@it.test'); // the owner is not disclosed
    expect(modelCalls()).toBe(0);
    expect(await count(ws)).toBe(0);
  });

  it("unverified workspace MEMBER of a verified owner's free workspace is refused", async () => {
    const ws = await seedWorkspace('free');
    await seedUser(ws, { verified: true, role: 'owner' });
    const member = await seedUser(ws, { verified: false, role: 'member' });
    const error = await service()
      .generateActionWithMetadata(member, explain('x'))
      .catch((e: HttpException) => e.getResponse() as Record<string, unknown>);
    expect(error).toMatchObject({
      code: 'EMAIL_VERIFICATION_REQUIRED',
      details: { reason: 'account' },
    });
    expect(await count(ws)).toBe(0);
  });

  it('concurrent requests of an unverified account: all refused, nothing reserved', async () => {
    const { ws, user } = await seed('free', false);
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        attempt(() => service().generateActionWithMetadata(user, explain(`c${i}`))),
      ),
    );
    expect(new Set(outcomes)).toEqual(new Set(['EMAIL_VERIFICATION_REQUIRED']));
    expect(modelCalls()).toBe(0);
    expect(await count(ws)).toBe(0);
    expect(await events(ws)).toBe(0);
  });

  it('confirming the email (real token flow) unlocks usage immediately — no cache delay', async () => {
    const { ws, user } = await seed('free', false);
    expect(await attempt(() => service().generateActionWithMetadata(user, explain('x')))).toBe(
      'EMAIL_VERIFICATION_REQUIRED',
    );
    const token = randomBytes(32).toString('base64url');
    await prisma.emailVerificationToken.create({
      data: {
        userId: user,
        email: `${user}@it.test`,
        tokenHash: hashVerificationToken(token),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    const verification = new EmailVerificationService(
      prisma as never,
      { send: vi.fn() } as never,
      { get: () => 'https://app.example.test' } as never,
    );
    await verification.confirm(token, user);
    expect(await attempt(() => service().generateActionWithMetadata(user, explain('x')))).toBe(
      'ok',
    );
    expect(await count(ws)).toBe(1);
  });

  it('switching workspaces cannot bypass the gate: every free workspace refuses; only a paid one serves', async () => {
    const own = await seedWorkspace('free');
    const user = await seedUser(own, { verified: false });
    const verifiedOwnersFree = await seedWorkspace('free');
    await seedUser(verifiedOwnersFree, { verified: true });
    await prisma.workspaceMembership.create({
      data: { workspaceId: verifiedOwnersFree, userId: user, role: 'member', status: 'active' },
    });
    const paid = await seedWorkspace('pro');
    await prisma.workspaceMembership.create({
      data: { workspaceId: paid, userId: user, role: 'member', status: 'active' },
    });
    const select = (ws: string) =>
      prisma.user.update({ where: { id: user }, data: { lastWorkspaceId: ws } });

    for (const ws of [own, verifiedOwnersFree]) {
      await select(ws);
      expect(await attempt(() => service().generateActionWithMetadata(user, explain(ws)))).toBe(
        'EMAIL_VERIFICATION_REQUIRED',
      );
      expect(await count(ws)).toBe(0);
    }
    // A workspace the user does not belong to is not a fallback either (N-1 unchanged).
    const foreign = await seedWorkspace('free');
    await seedUser(foreign, { verified: true });
    await select(foreign);
    expect(await attempt(() => service().generateActionWithMetadata(user, explain('f')))).not.toBe(
      'ok',
    );
    expect(await count(foreign)).toBe(0);
    // The paid workspace is governed by its paid entitlements (policy preserved).
    await select(paid);
    expect(await attempt(() => service().generateActionWithMetadata(user, explain('p')))).toBe(
      'ok',
    );
    expect(modelCalls()).toBe(1);
  });

  it("replay / resume cannot be used to obtain output: another user's operation id is refused for an unverified account", async () => {
    const ws = await seedWorkspace('free');
    const owner = await seedUser(ws, { verified: true });
    const first = await service().generateActionWithMetadata(owner, explain('shared prompt'));
    expect(modelCalls()).toBe(1);
    const intruder = await seedUser(ws, { verified: false, role: 'member' });
    const operationId = (first as { operationId?: string }).operationId ?? randomUUID();
    expect(
      await attempt(() =>
        service().generateActionWithMetadata(intruder, {
          ...(explain('shared prompt') as object),
          retryOperationId: operationId,
        } as never),
      ),
    ).toBe('EMAIL_VERIFICATION_REQUIRED');
    expect(modelCalls()).toBe(1);
    expect(await count(ws)).toBe(1); // only the owner's unit
  });

  it('creating a fresh free workspace does not bypass the gate (a new pool is still unverified)', async () => {
    const { user } = await seed('free', false);
    const fresh = await seedWorkspace('free');
    await prisma.workspaceMembership.create({
      data: { workspaceId: fresh, userId: user, role: 'owner', status: 'active' },
    });
    await prisma.user.update({ where: { id: user }, data: { lastWorkspaceId: fresh } });
    expect(await attempt(() => service().generateActionWithMetadata(user, explain('x')))).toBe(
      'EMAIL_VERIFICATION_REQUIRED',
    );
    expect(await count(fresh)).toBe(0);
  });

  it('refusals and exhausted free pools are recorded as durable abuse-monitoring events', async () => {
    const audit = { record: vi.fn() };
    const audited = new UsageService(
      prisma as never,
      new EntitlementService(prisma as never),
      audit as never,
    );
    const unverified = await seed('free', false);
    await expect(
      audited.reserve({
        workspaceId: unverified.ws,
        userId: unverified.user,
        metric: 'ai_action',
        operationId: randomUUID(),
      }),
    ).rejects.toMatchObject({ response: { code: 'EMAIL_VERIFICATION_REQUIRED' } });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'ai.free_quota.verification_required',
        outcome: 'blocked',
        actorUserId: unverified.user,
        workspaceId: unverified.ws,
        detail: 'reason=account',
      }),
    );

    const verified = await seed('free', true);
    await prisma.workspaceUsageCounter.create({
      data: {
        workspaceId: verified.ws,
        metric: 'ai_action',
        periodKey: usagePeriodKey(),
        count: 10_000,
      },
    });
    await expect(
      audited.reserve({
        workspaceId: verified.ws,
        userId: verified.user,
        metric: 'ai_action',
        operationId: randomUUID(),
      }),
    ).rejects.toMatchObject({ response: { code: 'USAGE_LIMIT_REACHED' } });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ai.free_quota.exhausted', workspaceId: verified.ws }),
    );
  });
});
