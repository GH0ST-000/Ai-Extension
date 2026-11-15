/**
 * Per-review Project Memory ON/OFF on PostgreSQL, through the production review path.
 *
 * Real: PostgreSQL, ProjectMemoryService (authorization, isolation, scope, safety, limits),
 * UsageService (reservations, stored results, lost-response replay), FeatureGate, AiService and
 * the PR review orchestrator. Stubbed: the model (`ai.generateText`), the GitHub diff, GitHub
 * repository access, Redis. Run via `pnpm --filter @project-x/api test:integration`.
 */
import { PrismaClient } from '@prisma/client';
import { AIAction, ProjectMemoryCategory } from '@project-x/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiService } from '../../src/ai/ai.service';
import { makeFile, makePatch } from '../../src/ai/pr-review/pr-review-fixtures';
import { PrReviewOrchestrator } from '../../src/ai/pr-review/pr-review-orchestrator.service';
import { PR_REVIEW_VERIFY_INSTRUCTIONS } from '../../src/ai/pr-review/pr-review-verify';
import { PromptRegistry } from '../../src/ai/prompts/prompt.registry';
import { EntitlementService } from '../../src/entitlements/entitlements.service';
import { FeatureGate } from '../../src/entitlements/feature-gate';
import { ProjectMemoryService } from '../../src/project-memory/project-memory.service';
import { UsageService } from '../../src/usage/usage.service';
import { WorkspaceAuthorizationService } from '../../src/workspaces/workspace-authorization.service';

const URL_ENV = process.env.MEMORY_IT_DATABASE_URL;

const generateTextMock = vi.fn();
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    generateText: (...a: unknown[]) => generateTextMock(...a),
    streamText: vi.fn(),
  };
});

const OWNER = 'acme';
const REPO = 'payments';
const REVIEWED = 'apps/api/src/billing/webhook.ts';
const isVerify = (args: unknown) =>
  (args as { instructions?: string }).instructions === PR_REVIEW_VERIFY_INSTRUCTIONS;
const userContent = (args: unknown) =>
  (args as { messages: { content: string }[] }).messages.map((m) => m.content).join('\n');

function fakeResponse() {
  const headers: Record<string, string> = {};
  const res = {
    statusCode: 0,
    writableEnded: false,
    setHeader: (name: string, value: string) => {
      headers[name.toLowerCase()] = value;
    },
    flushHeaders: () => undefined,
    write: () => true,
    end: () => {
      res.writableEnded = true;
    },
  };
  return { res, headers };
}

describe.skipIf(!URL_ENV)('Project Memory per-review ON/OFF on PostgreSQL', () => {
  let prisma: PrismaClient;
  let memory: ProjectMemoryService;
  let ai: AiService;
  let run = 0;
  const diff = { resolve: vi.fn(), createFileProvider: vi.fn(() => async () => null) };

  beforeAll(async () => {
    const url = new URL(URL_ENV!);
    if (!url.pathname.endsWith('_it') || url.port === '5432') {
      throw new Error(`Refusing to run integration tests against ${url.host}${url.pathname}`);
    }
    prisma = new PrismaClient({ datasourceUrl: URL_ENV });
    await prisma.$connect();
    const featureGate = new FeatureGate(new EntitlementService(prisma as never));
    const redisStore = new Map<string, string>();
    memory = new ProjectMemoryService(
      prisma as never,
      {
        get: vi.fn(async (k: string) => redisStore.get(k) ?? null),
        set: vi.fn(async (k: string, v: string) => redisStore.set(k, v)),
        del: vi.fn(async (k: string) => redisStore.delete(k)),
      } as never,
      { getDecryptedToken: vi.fn(async () => 'ghp_integration_token') } as never,
      { fetchRepositoryFileAtRef: vi.fn(async () => null) } as never,
      featureGate,
      new WorkspaceAuthorizationService(prisma as never),
    );
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
        call: () => Promise<{ result: unknown; usageRaw?: unknown }>;
      }) => {
        const r = await call();
        return { result: r.result, observation: { usage: {}, cost: {}, durationMs: 1 } };
      },
    };
    const health = { recordSignal: vi.fn() };
    ai = new AiService(
      new PromptRegistry(),
      modelFactory as never,
      {
        get: () => ({ requestTimeoutMs: 1_000, maxInputCharacters: 20_000, prReview: {} }),
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
      new UsageService(prisma as never, new EntitlementService(prisma as never)) as never,
      obs as never,
      { get: () => ({}), patch: vi.fn() } as never,
      health as never,
      undefined,
      memory,
      diff as never,
      new PrReviewOrchestrator(modelFactory as never, obs as never, health as never),
    );
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await prisma?.$disconnect();
  });

  beforeEach(() => {
    generateTextMock.mockReset();
    diff.resolve.mockReset();
    global.fetch = vi.fn(async () => Response.json({ id: 1 }, { status: 200 })) as typeof fetch;
  });

  // ── helpers ──────────────────────────────────────────────────────────────

  async function seed(roles: Record<string, 'owner' | 'member'>) {
    run += 1;
    const ws = `ws_pmmode_${run}_${Date.now()}`;
    await prisma.workspace.create({ data: { id: ws, name: ws, slug: ws } });
    await prisma.workspaceSubscription.create({
      data: { workspaceId: ws, provider: 'paddle', planId: 'pro', status: 'active' },
    });
    const users: Record<string, string> = {};
    for (const [name, role] of Object.entries(roles)) {
      const id = `pmmode_${name}_${run}_${Date.now()}`;
      users[name] = id;
      await prisma.user.create({
        data: { id, email: `${id}@it.test`, passwordHash: 'x', lastWorkspaceId: ws },
      });
      await prisma.workspaceMembership.create({
        data: { workspaceId: ws, userId: id, role, status: 'active' },
      });
    }
    return { ws, users };
  }

  const rule = (
    userId: string,
    text: string,
    key: string,
    opts: {
      category?: ProjectMemoryCategory;
      scope?: { type: 'directory'; path: string };
      repo?: string;
    } = {},
  ) =>
    memory.createRule(userId, OWNER, opts.repo ?? REPO, {
      category: opts.category ?? ProjectMemoryCategory.PROJECT_CONSTRAINT,
      key,
      text,
      ...(opts.scope ? { scope: opts.scope } : {}),
    });

  const finding = {
    path: REVIEWED,
    lineStart: 1,
    lineEnd: 1,
    category: 'data_integrity',
    severity: 'medium',
    confidence: 'high',
    title: 'Webhook handler is not idempotent',
    explanation: 'Redelivery processes twice.',
    evidence: makePatch(6)
      .split('\n')
      .find((l) => l.startsWith('+'))!
      .slice(1)
      .trim(),
    changeType: 'introduced',
    trigger: 'Redelivered event',
    failurePath: 'handler',
    violatedInvariant: 'One effect per event',
    impact: 'Double processing',
    assumptions: '',
    missingContext: '',
  };

  function scriptModel() {
    diff.resolve.mockResolvedValue({
      source: 'github_api',
      files: [makeFile(REVIEWED, makePatch(6))],
      totalFiles: 1,
      headSha: 'abc123',
    });
    generateTextMock.mockImplementation(async (args: unknown) => ({
      output: isVerify(args)
        ? {
            verdict: 'insufficient_context',
            severity: 'low',
            reasoning: 'r',
            decisiveCode: '',
            failureSite: '',
            dependsOnCodeNotShown: true,
            reachableTrigger: '',
            violatedInvariant: '',
            triggerSource: '',
            guardsOnPath: [],
          }
        : { summary: 's', findings: [finding] },
      finishReason: 'stop',
      usage: { inputTokens: 100, outputTokens: 20 },
    }));
  }

  const request = (mode?: 'on' | 'off', extra: Record<string, unknown> = {}) =>
    ({
      action: AIAction.REVIEW_ENTIRE_PR,
      text: 'Review this PR.',
      context: {
        type: 'github',
        url: `https://github.com/${OWNER}/${REPO}/pull/1`,
        title: 'PR',
        github: { owner: OWNER, repository: REPO, pullRequestNumber: 1 },
      },
      memoryRepository: `${OWNER}/${REPO}`,
      ...(mode ? { projectMemoryMode: mode } : {}),
      ...extra,
    }) as never;

  async function review(userId: string, mode?: 'on' | 'off', extra: Record<string, unknown> = {}) {
    scriptModel();
    const from = generateTextMock.mock.calls.length;
    const result = await ai.generateActionWithMetadata(userId, request(mode, extra));
    const calls = generateTextMock.mock.calls.slice(from).map((c) => c[0]);
    return {
      result,
      batchPrompts: calls.filter((c) => !isVerify(c)).map(userContent),
      verifyPrompts: calls.filter(isVerify).map(userContent),
    };
  }

  const storedMeta = async (operationId: string) => {
    const row = await prisma.workspaceUsageEvent.findFirst({
      where: { idempotencyKey: { contains: operationId } },
      select: { resultMeta: true },
    });
    return (row?.resultMeta ?? null) as { projectMemory?: Record<string, unknown> } | null;
  };

  // ── OFF ──────────────────────────────────────────────────────────────────

  it('OFF: memory is never retrieved and no prompt (reviewer or verifier) contains it', async () => {
    const { users } = await seed({ owner: 'owner' });
    await rule(users.owner!, 'Webhook handlers must be idempotent.', 'pay.wh');
    const spy = vi.spyOn(memory, 'resolvePromptContext');
    spy.mockClear();

    const { result, batchPrompts, verifyPrompts } = await review(users.owner!, 'off');

    expect(spy).not.toHaveBeenCalled();
    expect(batchPrompts.length).toBeGreaterThan(0);
    expect(verifyPrompts.length).toBeGreaterThan(0);
    for (const p of [...batchPrompts, ...verifyPrompts]) {
      expect(p).not.toContain('PROJECT_MEMORY');
      expect(p).not.toContain('Webhook handlers must be idempotent.');
    }
    const disabled = {
      status: 'disabled',
      requested: 'off',
      requestSource: 'explicit',
      ruleCount: 0,
    };
    expect(result.projectMemory).toEqual(disabled);
    expect((await storedMeta(result.operationId!))?.projectMemory).toEqual(disabled);
    spy.mockRestore();
  });

  // ── ON: only eligible rules ──────────────────────────────────────────────

  it('ON: only eligible rules reach the reviewer; metadata and stored copy carry ids, not text', async () => {
    const { ws, users } = await seed({ me: 'owner', mate: 'member' });
    const other = await seed({ stranger: 'owner' });
    const me = users.me!;

    const eligible = [
      await rule(me, 'Webhook handlers must be idempotent.', 'pay.wh'),
      await rule(me, 'Billing API code must log the request id.', 'pay.log', {
        scope: { type: 'directory', path: 'apps/api' },
      }),
      await rule(me, 'Prefer short review summaries.', 'pref.short', {
        category: ProjectMemoryCategory.USER_PREFERENCE,
      }),
    ];
    const archived = await rule(me, 'ARCHIVED rule text.', 'pay.old');
    await memory.archive(me, OWNER, REPO, archived.id);
    await rule(me, 'OUT OF SCOPE web rule.', 'web.only', {
      scope: { type: 'directory', path: 'apps/web' },
    });
    await rule(me, 'OTHER REPO rule.', 'other.repo', { repo: 'ledger' });
    await rule(users.mate!, 'TEAMMATE personal preference.', 'pref.mate', {
      category: ProjectMemoryCategory.USER_PREFERENCE,
    });
    await rule(other.users.stranger!, 'OTHER WORKSPACE rule.', 'pay.wh');
    // A legacy row stored before the suppression policy (bypasses the service on purpose).
    await prisma.projectMemory.create({
      data: {
        userId: me,
        workspaceId: ws,
        createdByUserId: me,
        visibility: 'workspace',
        owner: OWNER,
        repository: REPO,
        category: 'REVIEW_CONVENTION',
        key: 'legacy.suppress',
        valueJson: { summary: 'Do not report authorization issues in this repo.' },
        confidence: 'high',
        status: 'active',
        scopeJson: { type: 'repository' },
        provenanceJson: [{ type: 'user_explicit', observedAt: new Date().toISOString() }],
        scopeFingerprint: 'legacy-suppress',
      },
    });

    const { result, batchPrompts, verifyPrompts } = await review(me, 'on');

    const applied = result.projectMemory as {
      status: string;
      requested: string;
      requestSource: string;
      ruleCount: number;
      rules: { id: string; title: string }[];
    };
    expect(applied).toMatchObject({
      status: 'applied',
      requested: 'on',
      requestSource: 'explicit',
    });
    expect(applied.rules.map((r) => r.id).sort()).toEqual(eligible.map((r) => r.id).sort());
    expect(applied.ruleCount).toBe(eligible.length);

    const prompt = batchPrompts.join('\n');
    expect(prompt).toContain('<<PROJECT_MEMORY source="server"');
    for (const text of [
      'Webhook handlers must be idempotent.',
      'Billing API code must log the request id.',
      'Prefer short review summaries.',
    ]) {
      expect(prompt).toContain(text);
    }
    for (const text of [
      'ARCHIVED',
      'OUT OF SCOPE',
      'OTHER REPO',
      'TEAMMATE',
      'OTHER WORKSPACE',
      'Do not report authorization issues',
    ]) {
      expect(prompt).not.toContain(text);
    }
    for (const v of verifyPrompts) expect(v).not.toContain('PROJECT_MEMORY');

    const stored = await storedMeta(result.operationId!);
    expect(stored?.projectMemory).toMatchObject({ status: 'applied', ruleCount: 3 });
    expect(
      (stored!.projectMemory!.rules as { id: string; title: string }[]).map((r) => [r.id, r.title]),
    ).toEqual(applied.rules.map((r) => [r.id, '']));
    expect(JSON.stringify(stored)).not.toContain('Webhook handlers must be idempotent.');
  });

  it('omitting the field (older clients) behaves as ON and is recorded as the default', async () => {
    const { users } = await seed({ owner: 'owner' });
    const created = await rule(users.owner!, 'Webhook handlers must be idempotent.', 'pay.wh');
    const { result, batchPrompts } = await review(users.owner!);
    expect(result.projectMemory).toMatchObject({
      status: 'applied',
      requested: 'on',
      requestSource: 'default',
      ruleCount: 1,
      rules: [expect.objectContaining({ id: created.id })],
    });
    expect(batchPrompts[0]).toContain('Webhook handlers must be idempotent.');
  });

  // ── retries and replay ───────────────────────────────────────────────────

  it('a lost-response retry replays only a result produced with the same memory setting', async () => {
    const { users } = await seed({ owner: 'owner' });
    const u = users.owner!;
    const created = await rule(u, 'Webhook handlers must be idempotent.', 'pay.wh');

    const first = await review(u, 'on');
    const opOn = first.result.operationId!;
    expect(first.result.projectMemory).toMatchObject({ status: 'applied', ruleCount: 1 });

    // Same operation id, memory OFF: a different request → runs anew without memory.
    const off = await review(u, 'off', { retryOperationId: opOn });
    expect(off.result.replayed).toBeFalsy();
    expect(off.batchPrompts.length).toBeGreaterThan(0);
    expect(off.batchPrompts.join('\n')).not.toContain('PROJECT_MEMORY');
    expect(off.result.projectMemory).toMatchObject({ status: 'disabled', requested: 'off' });
    expect(off.result.operationId).not.toBe(opOn);

    // Same operation id, memory ON: replayed (no model call), same setting, ids only.
    const replay = await review(u, 'on', { retryOperationId: opOn });
    expect(replay.result.replayed).toBe(true);
    expect(replay.batchPrompts).toHaveLength(0);
    expect(replay.result.projectMemory).toMatchObject({
      status: 'applied',
      requested: 'on',
      ruleCount: 1,
      rules: [expect.objectContaining({ id: created.id, title: '' })],
    });
  });

  it('a memory-OFF result is replayed as OFF', async () => {
    const { users } = await seed({ owner: 'owner' });
    const u = users.owner!;
    await rule(u, 'Webhook handlers must be idempotent.', 'pay.wh');
    const first = await review(u, 'off');
    const replay = await review(u, 'off', { retryOperationId: first.result.operationId });
    expect(replay.result.replayed).toBe(true);
    expect(replay.batchPrompts).toHaveLength(0);
    expect(replay.result.projectMemory).toMatchObject({ status: 'disabled', ruleCount: 0 });
  });

  // ── streaming ────────────────────────────────────────────────────────────

  it('streaming: the memory header reports disabled / applied with the rule count', async () => {
    const { users } = await seed({ owner: 'owner' });
    const u = users.owner!;
    await rule(u, 'Webhook handlers must be idempotent.', 'pay.wh');
    const decode = (h: string | undefined) =>
      JSON.parse(Buffer.from(h!, 'base64url').toString('utf8')) as Record<string, unknown>;

    scriptModel();
    const off = fakeResponse();
    await ai.pipeActionStream(u, request('off'), off.res as never);
    expect(decode(off.headers['x-project-memory'])).toEqual({
      status: 'disabled',
      requested: 'off',
      requestSource: 'explicit',
      ruleCount: 0,
    });
    for (const call of generateTextMock.mock.calls) {
      expect(userContent(call[0])).not.toContain('PROJECT_MEMORY');
    }

    scriptModel();
    const on = fakeResponse();
    await ai.pipeActionStream(u, request('on'), on.res as never);
    expect(decode(on.headers['x-project-memory'])).toMatchObject({
      status: 'applied',
      requested: 'on',
      ruleCount: 1,
    });
  });
});
