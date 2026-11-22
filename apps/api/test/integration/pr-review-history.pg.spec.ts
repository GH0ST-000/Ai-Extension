/**
 * Persistent PR Review History on PostgreSQL (+ real HTTP for the read API).
 *
 * Real: PostgreSQL (migrations incl. the immutability trigger), AiService → orchestrator →
 * PrReviewHistoryService write path, UsageService reservations, PrReviewHistoryController +
 * WorkspaceGuard + WorkspaceAuthorizationService + ValidationPipe (main.ts options),
 * RequestContext middleware (X-Workspace-Id), GithubAccessService + installation lookup.
 * Stubbed: the model (`ai.generateText`), the PR diff, JWT (x-test-user), App token minting,
 * PAT storage, GitHub's REST API, Redis (in-memory).
 */
import { type INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
import { APICallError } from 'ai';
import type { NextFunction, Request, Response } from 'express';
import { usagePeriodKey } from '@project-x/shared';
import {
  AIAction,
  type PrReviewReportDetail,
  type ProjectMemoryPromptMetadata,
} from '@project-x/types';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiService } from '../../src/ai/ai.service';
import { makeFile, makePatch } from '../../src/ai/pr-review/pr-review-fixtures';
import { PrReviewOrchestrator } from '../../src/ai/pr-review/pr-review-orchestrator.service';
import { PromptRegistry } from '../../src/ai/prompts/prompt.registry';
import { JwtAuthGuard } from '../../src/auth/jwt-auth.guard';
import { encryptSecret } from '../../src/common/crypto/secret-box';
import { EntitlementService } from '../../src/entitlements/entitlements.service';
import { FeatureGate } from '../../src/entitlements/feature-gate';
import { GithubAccessService } from '../../src/github-app/github-access.service';
import { GithubAppInstallationService } from '../../src/github-app/github-app-installation.service';
import { ObservabilityExceptionFilter } from '../../src/observability/observability-exception.filter';
import { RequestContextMiddleware } from '../../src/observability/request-context.middleware';
import { RequestContextService } from '../../src/observability/request-context.service';
import { PrReviewHistoryController } from '../../src/pr-review-history/pr-review-history.controller';
import {
  PrReviewHistoryService,
  type RecordPrReviewInput,
} from '../../src/pr-review-history/pr-review-history.service';
import { UsageService } from '../../src/usage/usage.service';
import { WorkspaceAuthorizationService } from '../../src/workspaces/workspace-authorization.service';
import { WorkspaceGuard } from '../../src/workspaces/workspace.guard';

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
const ENCRYPTION_KEY = 'it-encryption-key-0123456789abcdef0123';
const INSTALLATION_REPOS: Record<string, string[]> = {};
const PATS: Record<string, string> = {};
/** Repositories for which GitHub answers 502 (transient outage). */
const FLAKY_REPOS = new Set<string>();
/** Stand-in for GitHubConnection row versions: each distinct stored token is a new version. */
const PAT_VERSIONS = new Map<string, string>();
function patVersion(userId: string, token: string): string {
  const key = `${userId}\u0000${token}`;
  if (!PAT_VERSIONS.has(key)) PAT_VERSIONS.set(key, `conn_${userId}:${PAT_VERSIONS.size + 1}`);
  return PAT_VERSIONS.get(key)!;
}
/** Access-cache stand-in state (see beforeAll). */
const cache: { offsetMs: number; store: Map<string, { value: string; expiresAt: number }> } = {
  offsetMs: 0,
  store: new Map(),
};

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

function fakeResponse() {
  const headers: Record<string, string> = {};
  const chunks: string[] = [];
  const res = {
    statusCode: 0,
    writableEnded: false,
    setHeader: (name: string, value: string) => {
      headers[name.toLowerCase()] = value;
    },
    flushHeaders: () => undefined,
    write: (chunk: string) => {
      chunks.push(chunk);
      return true;
    },
    end: () => {
      res.writableEnded = true;
    },
  };
  return { res, headers, body: () => chunks.join('') };
}

type Role = 'owner' | 'admin' | 'member';

describe.skipIf(!URL_ENV)('Persistent PR Review History on PostgreSQL', () => {
  let prisma: PrismaClient;
  let usage: UsageService;
  let history: PrReviewHistoryService;
  let app: INestApplication;
  let baseUrl: string;
  const realFetch = globalThis.fetch;
  const githubCalls: Array<{ method: string; url: string }> = [];
  // No head-file context provider: the model is stubbed, so verification context is not needed.
  const diff = { resolve: vi.fn(), createFileProvider: vi.fn(() => undefined) };
  const requestContext = new RequestContextService();
  let run = 0;

  beforeAll(async () => {
    const url = new URL(URL_ENV!);
    if (!url.pathname.endsWith('_it') || url.port === '5432') {
      throw new Error(`Refusing to run integration tests against ${url.host}${url.pathname}`);
    }
    prisma = new PrismaClient({ datasourceUrl: URL_ENV });
    await prisma.$connect();
    usage = new UsageService(prisma as never, new EntitlementService(prisma as never));

    const appTokens = {
      isAppAuthEnabled: () => true,
      mintInstallationAccessToken: async (installationId: string) => `ghs_inst_${installationId}`,
    };
    const installations = new GithubAppInstallationService(
      prisma as never,
      {} as never,
      { get: () => '', getOrThrow: () => ENCRYPTION_KEY } as never,
      appTokens as never,
      {} as never,
    );
    const githubAccess = new GithubAccessService(
      prisma as never,
      requestContext,
      appTokens as never,
      installations,
      {
        getDecryptedToken: async (userId: string) => PATS[userId] ?? null,
        // Like the real service: a non-secret row version that changes on every replacement.
        getConnectionVersion: async (userId: string) =>
          PATS[userId] ? patVersion(userId, PATS[userId]!) : null,
      } as never,
    );
    // TTL-aware Redis stand-in; `cacheClock.offsetMs` moves time forward for expiry tests.
    const redisStore = new Map<string, { value: string; expiresAt: number }>();
    cache.store = redisStore;
    history = new PrReviewHistoryService(
      prisma as never,
      githubAccess,
      {
        get: vi.fn(async (k: string) => {
          const hit = redisStore.get(k);
          return hit && hit.expiresAt > Date.now() + cache.offsetMs ? hit.value : null;
        }),
        set: vi.fn(async (k: string, v: string, _ex?: string, ttl?: number) =>
          redisStore.set(k, {
            value: v,
            expiresAt: Date.now() + cache.offsetMs + (ttl ?? 3_600) * 1_000,
          }),
        ),
      } as never,
      requestContext,
    );

    const moduleRef = await Test.createTestingModule({
      controllers: [PrReviewHistoryController],
      providers: [
        { provide: PrReviewHistoryService, useValue: history },
        {
          provide: WorkspaceAuthorizationService,
          useValue: new WorkspaceAuthorizationService(prisma as never),
        },
        WorkspaceGuard,
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (ctx: { switchToHttp: () => { getRequest: () => Request } }) => {
          const req = ctx.switchToHttp().getRequest() as Request & { user?: unknown };
          const id = req.header('x-test-user');
          if (!id) return false;
          req.user = { id, email: `${id}@it.test`, name: null };
          return true;
        },
      })
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    const middleware = new RequestContextMiddleware(
      requestContext,
      { shouldSample: () => false } as never,
      { get: () => undefined } as never,
    );
    app.use((req: Request, res: Response, next: NextFunction) => middleware.use(req, res, next));
    app.useGlobalFilters(new ObservabilityExceptionFilter(requestContext));
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await app?.close();
    await prisma?.$disconnect();
  });

  beforeEach(() => {
    generateTextMock.mockReset().mockImplementation(async () => ok());
    diff.resolve.mockReset();
    githubCalls.length = 0;
    // GitHub: an installation sees only its repositories; a personal token (ghp_*) sees all.
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const target = String(input);
      if (!target.startsWith('https://api.github.com/')) return realFetch(input, init);
      githubCalls.push({ method: init?.method ?? 'GET', url: target });
      const token = (new Headers(init?.headers).get('authorization') ?? '').replace(
        /^Bearer\s+/i,
        '',
      );
      const match = /\/repos\/([^/]+)\/([^/?]+)/.exec(target);
      const full = match ? `${decodeURIComponent(match[1]!)}/${decodeURIComponent(match[2]!)}` : '';
      if (FLAKY_REPOS.has(full)) return Response.json({ message: 'Bad gateway' }, { status: 502 });
      if (token.startsWith('ghs_inst_')) {
        const repos = INSTALLATION_REPOS[token.slice('ghs_inst_'.length)] ?? [];
        return repos.includes(full)
          ? Response.json({ id: 1, full_name: full })
          : Response.json({ message: 'Not Found' }, { status: 404 });
      }
      // A personal token without access to anything (e.g. a replaced, narrower token).
      if (token.startsWith('ghp_none_'))
        return Response.json({ message: 'Not Found' }, { status: 404 });
      // As GitHub answers an authenticated user: with that user's permissions.
      if (token.startsWith('ghp_'))
        return Response.json({ id: 1, full_name: full, permissions: { pull: true, push: true } });
      return Response.json({ message: 'Bad credentials' }, { status: 401 });
    }) as typeof fetch;
  });

  // ── helpers ──────────────────────────────────────────────────────────────

  async function seed(opts: {
    roles: Record<string, Role>;
    installation?: string[];
    /** Members with a personal GitHub token (default: everyone, unless `tokenless`). */
    withPat?: string[];
    /** H1: nobody connects a personal token (App-only viewers). */
    tokenless?: boolean;
  }) {
    run += 1;
    const tag = `${run}_${Date.now()}`;
    const ws = `ws_prh_${tag}`;
    await prisma.workspace.create({ data: { id: ws, name: ws, slug: ws } });
    await prisma.workspaceSubscription.create({
      data: { workspaceId: ws, provider: 'paddle', planId: 'team', status: 'active' },
    });
    if (opts.installation) {
      const installationId = `8${run}${Date.now() % 100000}`;
      INSTALLATION_REPOS[installationId] = opts.installation;
      await prisma.gitHubAppInstallation.create({
        data: {
          workspaceId: ws,
          installationId,
          accountLogin: 'acme',
          accountType: 'Organization',
          repositorySelection: 'selected',
          status: 'active',
          metadataCiphertext: encryptSecret(
            JSON.stringify({
              ownership: {
                githubUserId: 1,
                githubLogin: 'acme-admin',
                accountType: 'Organization',
                verifiedAt: new Date().toISOString(),
                linkedByUserId: 'seed',
              },
            }),
            ENCRYPTION_KEY,
          ),
        },
      });
    }
    const users: Record<string, string> = {};
    for (const [name, role] of Object.entries(opts.roles)) {
      const id = `prh_${name}_${tag}`;
      users[name] = id;
      await prisma.user.create({
        data: {
          id,
          name: `User ${name}`,
          email: `${id}@it.test`,
          passwordHash: 'x',
          lastWorkspaceId: ws,
        },
      });
      await prisma.workspaceMembership.create({
        data: { workspaceId: ws, userId: id, role, status: 'active' },
      });
      // H1: with the workspace App a viewer still needs a verified identity (personal token).
      const hasPat = opts.withPat ? opts.withPat.includes(name) : !opts.tokenless;
      if (hasPat) PATS[id] = `ghp_${name}_${tag}`;
    }
    return { ws, users };
  }

  let opSeq = 0;
  function recordInput(
    over: Partial<RecordPrReviewInput> & { workspaceId: string; userId: string },
  ): RecordPrReviewInput {
    opSeq += 1;
    const now = new Date();
    return {
      operationId: `00000000-0000-4000-8000-${String(opSeq).padStart(12, '0')}`,
      owner: 'acme',
      repository: 'app',
      pullRequestNumber: 1,
      status: 'completed',
      coverage: null,
      reviewScope: {
        source: 'github_api',
        totalFiles: 1,
        analyzedFiles: 1,
        skippedFiles: 0,
        truncated: false,
      },
      findings: [],
      outcomes: [{ id: 'b1', status: 'succeeded', attempts: 1, files: 1 }],
      durationMs: 10,
      batchCount: 1,
      markdown: '## Summary\nfine',
      startedAt: now,
      completedAt: now,
      ...over,
    };
  }

  async function call(user: string | null, path: string, headers: Record<string, string> = {}) {
    const response = await realFetch(`${baseUrl}/api${path}`, {
      headers: { ...(user ? { 'x-test-user': user } : {}), ...headers },
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: response.status, body: body as Record<string, unknown> };
  }

  function aiService(historyOverride?: PrReviewHistoryService) {
    const featureGate = new FeatureGate(new EntitlementService(prisma as never));
    const modelFactory = {
      getDefaultModel: () => 'm',
      getProviderName: () => 'openai',
      getModelName: () => 'm',
    };
    const obs = {
      createOperationId: () => 'op',
      observeGenerate: async ({
        call: c,
      }: {
        call: () => Promise<{
          result: unknown;
          usageRaw?: { inputTokens?: number; outputTokens?: number };
        }>;
      }) => {
        const r = await c();
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
      historyOverride ?? history,
    );
  }

  const reviewInput = (extra: Record<string, unknown> = {}) =>
    ({
      action: AIAction.REVIEW_ENTIRE_PR,
      text: 'Review this PR.',
      context: {
        type: 'github',
        url: 'https://github.com/Acme/App/pull/7',
        title: 'PR',
        github: {
          owner: 'Acme',
          repository: 'App',
          pullRequestNumber: 7,
          pullRequestTitle: 'Add webhooks',
        },
      },
      ...extra,
    }) as never;
  const manyFiles = () =>
    Array.from({ length: 40 }, (_, i) =>
      makeFile(`src/f${i}.ts`, makePatch(55, { tag: `f${i}_` })),
    );
  const oneFile = () => ({
    source: 'github_api',
    files: [makeFile('src/a.ts', makePatch(5))],
    totalFiles: 1,
    headSha: 'a'.repeat(40),
  });

  async function charged(ws: string) {
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

  // ── write path (lifecycle) ───────────────────────────────────────────────

  it('a completed review is saved once with its metadata, exactly as delivered', async () => {
    const { ws, users } = await seed({ roles: { owner: 'owner' } });
    diff.resolve.mockResolvedValue(oneFile());
    const result = await aiService().generateActionWithMetadata(users.owner!, reviewInput());
    const rows = await prisma.prReviewReport.findMany({ where: { workspaceId: ws } });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      operationId: result.operationId,
      userId: users.owner,
      owner: 'acme',
      repository: 'app',
      pullRequestNumber: 7,
      pullRequestTitle: 'Add webhooks',
      headSha: 'a'.repeat(40),
      status: 'completed',
      coverageComplete: true,
      filesReviewed: 1,
      filesTotal: 1,
      schemaVersion: 1,
      reportMarkdown: result.text,
    });
    expect(row.completedAt.getTime()).toBeGreaterThanOrEqual(row.startedAt.getTime());
    expect(await charged(ws)).toBe(1);
  });

  it('a partially failed review is saved as partial (charged once)', async () => {
    const { ws, users } = await seed({ roles: { owner: 'owner' } });
    diff.resolve.mockResolvedValue({ source: 'github_api', files: manyFiles(), totalFiles: 40 });
    generateTextMock.mockImplementation(async (args: { messages: { content: string }[] }) => {
      if (args.messages[0]!.content.includes('### file: src/f0.ts\n')) throw transient();
      return ok();
    });
    await aiService().generateActionWithMetadata(users.owner!, reviewInput());
    const row = await prisma.prReviewReport.findFirstOrThrow({ where: { workspaceId: ws } });
    expect(row.status).toBe('partial');
    expect(row.coverageComplete).toBe(false);
    const snapshot = row.snapshot as { failure?: { code: string; failedBatches: number } };
    expect(snapshot.failure).toEqual({ code: 'some_batches_failed', failedBatches: 1 });
    expect(await charged(ws)).toBe(1);
  });

  it('a review where every batch fails is saved as failed, without a report or a charge', async () => {
    const { ws, users } = await seed({ roles: { owner: 'owner' } });
    diff.resolve.mockResolvedValue(oneFile());
    generateTextMock.mockRejectedValue(transient());
    await expect(
      aiService().generateActionWithMetadata(users.owner!, reviewInput()),
    ).rejects.toThrow();
    const row = await prisma.prReviewReport.findFirstOrThrow({ where: { workspaceId: ws } });
    expect(row).toMatchObject({
      status: 'failed',
      failureCode: 'all_batches_failed',
      reportMarkdown: null,
      riskLevel: null,
      findingsCount: 0,
    });
    expect(await charged(ws)).toBe(0);
  });

  it('retry after a failure creates a new report for the new execution (no duplicates)', async () => {
    const { ws, users } = await seed({ roles: { owner: 'owner' } });
    diff.resolve.mockResolvedValue(oneFile());
    generateTextMock.mockRejectedValue(transient());
    await expect(
      aiService().generateActionWithMetadata(users.owner!, reviewInput()),
    ).rejects.toThrow();
    generateTextMock.mockReset().mockImplementation(async () => ok());
    await aiService().generateActionWithMetadata(users.owner!, reviewInput());
    const rows = await prisma.prReviewReport.findMany({
      where: { workspaceId: ws },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((r) => r.status)).toEqual(['failed', 'completed']);
    expect(new Set(rows.map((r) => r.operationId)).size).toBe(2);
    expect(await charged(ws)).toBe(1);
  });

  it('a lost-response replay returns the stored result without a new report or charge', async () => {
    const { ws, users } = await seed({ roles: { owner: 'owner' } });
    diff.resolve.mockResolvedValue(oneFile());
    const first = await aiService().generateActionWithMetadata(users.owner!, reviewInput());
    generateTextMock.mockClear();
    const replay = await aiService().generateActionWithMetadata(
      users.owner!,
      reviewInput({ retryOperationId: first.operationId }),
      { allowReplay: true } as never,
    );
    expect(replay.text).toBe(first.text);
    expect(generateTextMock).not.toHaveBeenCalled();
    expect(await prisma.prReviewReport.count({ where: { workspaceId: ws } })).toBe(1);
    expect(await charged(ws)).toBe(1);
  });

  it('a cancelled review and a review with nothing reviewable are not saved', async () => {
    const { ws, users } = await seed({ roles: { owner: 'owner' } });
    diff.resolve.mockResolvedValue(oneFile());
    const controller = new AbortController();
    generateTextMock.mockImplementation(async () => {
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    const cancelled = fakeResponse();
    await aiService().pipeActionStream(
      users.owner!,
      reviewInput(),
      cancelled.res as never,
      controller.signal,
    );

    generateTextMock.mockReset().mockImplementation(async () => ok());
    diff.resolve.mockResolvedValue({
      source: 'github_api',
      files: [makeFile('pnpm-lock.yaml', makePatch(3))],
      totalFiles: 1,
    });
    await aiService().generateActionWithMetadata(users.owner!, reviewInput());

    expect(await prisma.prReviewReport.count({ where: { workspaceId: ws } })).toBe(0);
    expect(await charged(ws)).toBe(0);
  });

  it('streaming: the delivered stream is unchanged and saved once', async () => {
    const { ws, users } = await seed({ roles: { owner: 'owner' } });
    diff.resolve.mockResolvedValue(oneFile());
    const stream = fakeResponse();
    await aiService().pipeActionStream(users.owner!, reviewInput(), stream.res as never);
    const row = await prisma.prReviewReport.findFirstOrThrow({ where: { workspaceId: ws } });
    expect(stream.body().trimStart()).toBe(row.reportMarkdown);
    expect(row.operationId).toBe(stream.headers['x-ai-operation-id']);
    expect(await prisma.prReviewReport.count({ where: { workspaceId: ws } })).toBe(1);
    expect(await charged(ws)).toBe(1);
  });

  it('a history storage failure never breaks the review or its billing', async () => {
    const { ws, users } = await seed({ roles: { owner: 'owner' } });
    diff.resolve.mockResolvedValue(oneFile());
    const broken = new PrReviewHistoryService(
      {
        prReviewReport: {
          create: vi.fn(async () => {
            throw new Error('db down');
          }),
        },
      } as never,
      {} as never,
      {} as never,
      requestContext,
    );
    const result = await aiService(broken).generateActionWithMetadata(users.owner!, reviewInput());
    expect(result.text).toContain('Summary');
    // Truthful: the review is delivered and charged, but not reported as saved.
    expect(result.reviewHistory).toEqual({ status: 'not_saved' });
    expect(await charged(ws)).toBe(1);
  });

  it('persistence is idempotent per operation, also under concurrency', async () => {
    const { ws, users } = await seed({ roles: { owner: 'owner' } });
    const input = recordInput({ workspaceId: ws, userId: users.owner! });
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => history.record(input)));
    const rows = await prisma.prReviewReport.findMany({ where: { workspaceId: ws } });
    expect(rows).toHaveLength(1);
    // Every caller gets the database-confirmed id of the single stored row.
    expect(outcomes).toEqual(Array(6).fill({ status: 'saved', reportId: rows[0]!.id }));
    expect(await history.record({ ...input, status: 'failed', markdown: null })).toEqual({
      status: 'saved',
      reportId: rows[0]!.id,
    });
    expect(rows[0]!.status).toBe('completed');
  });

  it('snapshots are immutable in the database; deleting the initiator only detaches them', async () => {
    const { ws, users } = await seed({ roles: { owner: 'owner', member: 'member' } });
    await history.record(recordInput({ workspaceId: ws, userId: users.member! }));
    const row = await prisma.prReviewReport.findFirstOrThrow({ where: { workspaceId: ws } });
    await expect(
      prisma.prReviewReport.update({ where: { id: row.id }, data: { status: 'failed' } }),
    ).rejects.toThrow(/immutable/);
    await expect(
      prisma.prReviewReport.update({ where: { id: row.id }, data: { reportMarkdown: 'tampered' } }),
    ).rejects.toThrow(/immutable/);
    await prisma.workspaceMembership.deleteMany({ where: { userId: users.member! } });
    await prisma.user.delete({ where: { id: users.member! } });
    const after = await prisma.prReviewReport.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.userId).toBeNull();
    expect(after.reportMarkdown).toBe(row.reportMarkdown);
    expect(after.snapshot).toEqual(row.snapshot);
  });

  // ── read API: authorization ──────────────────────────────────────────────

  it('Owner, Admin and Member can browse and open the workspace history', async () => {
    const { ws, users } = await seed({
      roles: { owner: 'owner', admin: 'admin', member: 'member' },
      installation: ['acme/app'],
    });
    await history.record(recordInput({ workspaceId: ws, userId: users.member! }));
    for (const who of ['owner', 'admin', 'member'] as const) {
      const list = await call(users[who]!, `/workspaces/${ws}/pr-reviews`);
      expect(list.status).toBe(200);
      const items = list.body.items as Array<{
        id: string;
        initiatedByMe: boolean;
        initiatorName: string | null;
      }>;
      expect(items).toHaveLength(1);
      expect(items[0]!.initiatedByMe).toBe(who === 'member');
      expect(items[0]!.initiatorName).toBe('User member');
      expect(JSON.stringify(list.body)).not.toContain('@it.test');
      const detail = await call(users[who]!, `/workspaces/${ws}/pr-reviews/${items[0]!.id}`);
      expect(detail.status).toBe(200);
      expect(detail.body.reportMarkdown).toBe('## Summary\nfine');
    }
  });

  it('non-members and other tenants cannot read; a report id alone grants nothing (IDOR)', async () => {
    const a = await seed({ roles: { owner: 'owner' }, installation: ['acme/app'] });
    const b = await seed({ roles: { owner: 'owner' }, installation: ['acme/app'] });
    await history.record(recordInput({ workspaceId: a.ws, userId: a.users.owner! }));
    const id = (await prisma.prReviewReport.findFirstOrThrow({ where: { workspaceId: a.ws } })).id;

    // B's owner through A's URL: not a member → 403, nothing leaks.
    for (const path of [
      `/workspaces/${a.ws}/pr-reviews`,
      `/workspaces/${a.ws}/pr-reviews/${id}`,
      `/workspaces/${a.ws}/pr-reviews/latest?owner=acme&repository=app&pullRequestNumber=1`,
    ]) {
      const res = await call(b.users.owner!, path);
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).not.toContain('Summary');
    }
    // B's owner through B's URL with A's report id → 404 (same as a missing id).
    const cross = await call(b.users.owner!, `/workspaces/${b.ws}/pr-reviews/${id}`);
    expect(cross.status).toBe(404);
    const missing = await call(
      b.users.owner!,
      `/workspaces/${b.ws}/pr-reviews/clxxxxxxxxxxxxxxxxxxxxxxx`,
    );
    expect(missing.status).toBe(404);
    expect(cross.body.message).toBe(missing.body.message);
    // B's list never contains A's reports.
    const list = await call(b.users.owner!, `/workspaces/${b.ws}/pr-reviews`);
    expect(list.body.items).toEqual([]);
    // Unauthenticated.
    expect((await call(null, `/workspaces/${a.ws}/pr-reviews/${id}`)).status).toBe(403);
    // Malformed ids never reach the database lookup as anything but "not found".
    expect(
      (await call(a.users.owner!, `/workspaces/${a.ws}/pr-reviews/..%2F..%2Fetc`)).status,
    ).toBe(404);
  });

  it('rejects an X-Workspace-Id that differs from the workspace in the URL', async () => {
    const a = await seed({ roles: { owner: 'owner' }, installation: ['acme/app'] });
    const b = await seed({ roles: { owner: 'owner' }, installation: ['acme/app'] });
    await prisma.workspaceMembership.create({
      data: { workspaceId: b.ws, userId: a.users.owner!, role: 'member', status: 'active' },
    });
    const res = await call(a.users.owner!, `/workspaces/${a.ws}/pr-reviews`, {
      'X-Workspace-Id': b.ws,
    });
    expect(res.status).toBe(400);
  });

  it('repository access is enforced: inaccessible repositories are hidden and not openable', async () => {
    const { ws, users } = await seed({
      roles: { owner: 'owner', member: 'member', dev: 'member' },
      installation: ['acme/app'],
    });
    await history.record(recordInput({ workspaceId: ws, userId: users.owner!, repository: 'app' }));
    await history.record(
      recordInput({ workspaceId: ws, userId: users.owner!, repository: 'secret' }),
    );
    const secretId = (
      await prisma.prReviewReport.findFirstOrThrow({
        where: { workspaceId: ws, repository: 'secret' },
      })
    ).id;

    const member = await call(users.member!, `/workspaces/${ws}/pr-reviews`);
    expect((member.body.items as Array<{ repository: string }>).map((i) => i.repository)).toEqual([
      'app',
    ]);
    expect(member.body.someRepositoriesHidden).toBe(true);
    expect(JSON.stringify(member.body)).not.toContain('secret');
    expect((await call(users.member!, `/workspaces/${ws}/pr-reviews/${secretId}`)).status).toBe(
      404,
    );
    expect(
      (
        await call(
          users.member!,
          `/workspaces/${ws}/pr-reviews/latest?owner=acme&repository=secret&pullRequestNumber=1`,
        )
      ).status,
    ).toBe(404);
    // Owners are not exempt from repository authorization.
    expect((await call(users.owner!, `/workspaces/${ws}/pr-reviews/${secretId}`)).status).toBe(404);
  });

  it('a workspace without a GitHub App: only members whose own token can see the repository read it', async () => {
    const { ws, users } = await seed({
      roles: { owner: 'owner', member: 'member' },
      withPat: ['owner'],
    });
    await history.record(recordInput({ workspaceId: ws, userId: users.owner! }));
    const id = (await prisma.prReviewReport.findFirstOrThrow({ where: { workspaceId: ws } })).id;
    expect((await call(users.owner!, `/workspaces/${ws}/pr-reviews/${id}`)).status).toBe(200);
    expect((await call(users.member!, `/workspaces/${ws}/pr-reviews/${id}`)).status).toBe(404);
    const list = await call(users.member!, `/workspaces/${ws}/pr-reviews`);
    expect(list.body).toEqual({
      items: [],
      nextCursor: null,
      someRepositoriesHidden: true,
      accessCheckIncomplete: false,
    });
  });

  // ── read API: privacy ────────────────────────────────────────────────────

  it('personal preferences stay private, including from Owners; rule text is never stored', async () => {
    const { ws, users } = await seed({
      roles: { owner: 'owner', member: 'member' },
      installation: ['acme/app'],
    });
    const memory: ProjectMemoryPromptMetadata = {
      status: 'applied',
      version: 'v1',
      requested: 'on',
      requestSource: 'explicit',
      ruleCount: 3,
      rules: [
        {
          id: 'r_shared',
          key: 'pay.wh',
          category: 'convention' as never,
          title: 'SHARED RULE TEXT',
          confidence: 'high',
          visibility: 'workspace',
        },
        {
          id: 'r_p1',
          key: 'me.style',
          category: 'preference' as never,
          title: 'PRIVATE PREF ONE',
          confidence: 'high',
          visibility: 'user',
        },
        {
          id: 'r_p2',
          key: 'me.tone',
          category: 'preference' as never,
          title: 'PRIVATE PREF TWO',
          confidence: 'medium',
          visibility: 'user',
        },
      ],
    };
    await history.record(recordInput({ workspaceId: ws, userId: users.member!, memory }));
    const row = await prisma.prReviewReport.findFirstOrThrow({ where: { workspaceId: ws } });
    const stored = JSON.stringify(row);
    for (const secret of [
      'SHARED RULE TEXT',
      'PRIVATE PREF ONE',
      'PRIVATE PREF TWO',
      'r_p1',
      'r_p2',
      'me.style',
      'me.tone',
    ]) {
      expect(stored).not.toContain(secret);
    }
    expect(row.memoryMode).toBe('on');
    expect(row.memoryStatus).toBe('applied');

    const mine = (await call(users.member!, `/workspaces/${ws}/pr-reviews/${row.id}`))
      .body as unknown as PrReviewReportDetail;
    expect(mine.snapshot.memory).toMatchObject({
      ruleCount: 3,
      personalRuleCount: 2,
      sharedRules: [{ id: 'r_shared', key: 'pay.wh' }],
    });
    const owner = (await call(users.owner!, `/workspaces/${ws}/pr-reviews/${row.id}`))
      .body as unknown as PrReviewReportDetail;
    expect(owner.snapshot.memory).toEqual({
      mode: 'on',
      status: 'applied',
      requestSource: 'explicit',
      ruleCount: 1,
      sharedRules: [{ id: 'r_shared', key: 'pay.wh', category: 'convention', confidence: 'high' }],
    });
  });

  it('memory OFF is recorded as off', async () => {
    const { ws, users } = await seed({ roles: { owner: 'owner' }, installation: ['acme/app'] });
    await history.record(
      recordInput({
        workspaceId: ws,
        userId: users.owner!,
        memory: { status: 'disabled', requested: 'off', requestSource: 'explicit', ruleCount: 0 },
      }),
    );
    const row = await prisma.prReviewReport.findFirstOrThrow({ where: { workspaceId: ws } });
    expect(row.memoryMode).toBe('off');
    expect(row.memoryStatus).toBe('disabled');
  });

  // ── read API: listing, filters, pagination, latest ───────────────────────

  it('paginates with a bounded, stable cursor and validates query input', async () => {
    const { ws, users } = await seed({ roles: { owner: 'owner' }, installation: ['acme/app'] });
    for (let i = 0; i < 23; i += 1) {
      await history.record(
        recordInput({ workspaceId: ws, userId: users.owner!, pullRequestNumber: (i % 3) + 1 }),
      );
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await call(
        users.owner!,
        `/workspaces/${ws}/pr-reviews?limit=10${cursor ? `&cursor=${cursor}` : ''}`,
      );
      expect(res.status).toBe(200);
      const items = res.body.items as Array<{ id: string; createdAt: string }>;
      expect(items.length).toBeLessThanOrEqual(10);
      seen.push(...items.map((i) => i.id));
      cursor = res.body.nextCursor as string | null;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(23);

    expect((await call(users.owner!, `/workspaces/${ws}/pr-reviews?limit=51`)).status).toBe(400);
    expect((await call(users.owner!, `/workspaces/${ws}/pr-reviews?limit=0`)).status).toBe(400);
    expect(
      (await call(users.owner!, `/workspaces/${ws}/pr-reviews?cursor=not-a-cursor`)).status,
    ).toBe(400);
    expect((await call(users.owner!, `/workspaces/${ws}/pr-reviews?status=deleted`)).status).toBe(
      400,
    );
    expect((await call(users.owner!, `/workspaces/${ws}/pr-reviews?owner=../x`)).status).toBe(400);
    expect(
      (await call(users.owner!, `/workspaces/${ws}/pr-reviews?pullRequestNumber=2`)).status,
    ).toBe(400);
    expect((await call(users.owner!, `/workspaces/${ws}/pr-reviews?unknown=1`)).status).toBe(400);
    // The list never carries findings or report text (bounded payload).
    const first = await call(users.owner!, `/workspaces/${ws}/pr-reviews?limit=50`);
    expect(JSON.stringify(first.body)).not.toContain('Summary');
  });

  it('filters by repository, pull request and status; latest returns the newest report of a PR', async () => {
    const { ws, users } = await seed({
      roles: { owner: 'owner' },
      installation: ['acme/app', 'acme/web'],
    });
    const t = (s: number) => new Date(Date.now() - s * 1000);
    await history.record(
      recordInput({
        workspaceId: ws,
        userId: users.owner!,
        pullRequestNumber: 5,
        status: 'failed',
        markdown: null,
        failureCode: 'all_batches_failed',
        startedAt: t(30),
        completedAt: t(30),
      }),
    );
    await history.record(
      recordInput({
        workspaceId: ws,
        userId: users.owner!,
        pullRequestNumber: 5,
        status: 'partial',
        markdown: '## partial',
      }),
    );
    await history.record(
      recordInput({
        workspaceId: ws,
        userId: users.owner!,
        repository: 'web',
        pullRequestNumber: 5,
      }),
    );

    const byPr = await call(
      users.owner!,
      `/workspaces/${ws}/pr-reviews?owner=ACME&repository=app&pullRequestNumber=5`,
    );
    expect((byPr.body.items as unknown[]).length).toBe(2);
    const failed = await call(users.owner!, `/workspaces/${ws}/pr-reviews?status=failed`);
    expect((failed.body.items as Array<{ status: string }>).map((i) => i.status)).toEqual([
      'failed',
    ]);
    const web = await call(users.owner!, `/workspaces/${ws}/pr-reviews?owner=acme&repository=web`);
    expect((web.body.items as Array<{ repository: string }>).map((i) => i.repository)).toEqual([
      'web',
    ]);

    const latest = await call(
      users.owner!,
      `/workspaces/${ws}/pr-reviews/latest?owner=acme&repository=app&pullRequestNumber=5`,
    );
    expect((latest.body.report as PrReviewReportDetail).status).toBe('partial');
    expect((latest.body.report as PrReviewReportDetail).reportMarkdown).toBe('## partial');
    const none = await call(
      users.owner!,
      `/workspaces/${ws}/pr-reviews/latest?owner=acme&repository=app&pullRequestNumber=99`,
    );
    expect(none.status).toBe(200);
    expect(none.body.report).toBeNull();
  });

  it('opening history makes no AI call, no charge and no GitHub write', async () => {
    const { ws, users } = await seed({ roles: { owner: 'owner' }, installation: ['acme/app'] });
    await history.record(recordInput({ workspaceId: ws, userId: users.owner! }));
    const id = (await prisma.prReviewReport.findFirstOrThrow({ where: { workspaceId: ws } })).id;
    const before = await prisma.prReviewReport.findUniqueOrThrow({ where: { id } });
    generateTextMock.mockClear();
    await call(users.owner!, `/workspaces/${ws}/pr-reviews`);
    await call(users.owner!, `/workspaces/${ws}/pr-reviews/${id}`);
    await call(
      users.owner!,
      `/workspaces/${ws}/pr-reviews/latest?owner=acme&repository=app&pullRequestNumber=1`,
    );
    expect(generateTextMock).not.toHaveBeenCalled();
    expect(await charged(ws)).toBe(0);
    expect(await prisma.workspaceUsageEvent.count({ where: { workspaceId: ws } })).toBe(0);
    expect(githubCalls.length).toBeGreaterThan(0);
    for (const c of githubCalls) {
      expect(c.method).toBe('GET');
      expect(c.url).toMatch(/^https:\/\/api\.github\.com\/repos\/acme\/app$/);
    }
    expect(await prisma.prReviewReport.findUniqueOrThrow({ where: { id } })).toEqual(before);
  });

  // ── listing beyond 100 repositories (scan budget, cursor correctness) ────

  async function walk(user: string, ws: string, query = '', limit = 10) {
    const ids: string[] = [];
    const perRequestGithubCalls: number[] = [];
    let cursor: string | null = null;
    let requests = 0;
    let hidden = false;
    do {
      const before = githubCalls.length;
      const res = await call(
        user,
        `/workspaces/${ws}/pr-reviews?limit=${limit}${query}${cursor ? `&cursor=${cursor}` : ''}`,
      );
      expect(res.status).toBe(200);
      perRequestGithubCalls.push(githubCalls.length - before);
      ids.push(...(res.body.items as Array<{ id: string }>).map((i) => i.id));
      hidden ||= res.body.someRepositoriesHidden as boolean;
      expect(res.body.accessCheckIncomplete).toBe(false);
      cursor = res.body.nextCursor as string | null;
      requests += 1;
    } while (cursor && requests < 100);
    return { ids, perRequestGithubCalls, requests, hidden };
  }

  it('reports in older repositories beyond the 100 most recent are listed, never inaccessible ones', async () => {
    // 10 old accessible repositories, then 120 newer repositories the App cannot see.
    const accessible = Array.from({ length: 10 }, (_, i) => `acme/old${i}`);
    const { ws, users } = await seed({ roles: { member: 'member' }, installation: accessible });
    const expected: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      await history.record(
        recordInput({ workspaceId: ws, userId: users.member!, repository: `old${i}` }),
      );
      expected.unshift(
        (
          await prisma.prReviewReport.findFirstOrThrow({
            where: { workspaceId: ws, repository: `old${i}` },
          })
        ).id,
      );
    }
    for (let i = 0; i < 120; i += 1) {
      await history.record(
        recordInput({ workspaceId: ws, userId: users.member!, repository: `new${i}` }),
      );
    }

    const first = await walk(users.member!, ws);
    expect(first.ids).toEqual(expected); // all accessible reports, in order, no duplicates
    expect(first.hidden).toBe(true);
    // Bounded GitHub fan-out per request; the walk needed several short pages. Under H1 each
    // lookup is two calls (the user's own permission, then the App's view): ≤ 20 lookups.
    expect(Math.max(...first.perRequestGithubCalls)).toBeLessThanOrEqual(40);
    expect(first.requests).toBeGreaterThan(1);
    // Inaccessible repositories never appear.
    const listed = await prisma.prReviewReport.findMany({ where: { id: { in: first.ids } } });
    expect(listed.every((r) => r.repository.startsWith('old'))).toBe(true);

    // Second walk: every decision is cached → no GitHub calls, same result.
    const second = await walk(users.member!, ws);
    expect(second.ids).toEqual(expected);
    expect(second.perRequestGithubCalls.every((n) => n === 0)).toBe(true);
  });

  it('cursor pagination stays exact with interleaved accessible and hidden reports', async () => {
    const { ws, users } = await seed({ roles: { member: 'member' }, installation: ['acme/app'] });
    const expected: string[] = [];
    for (let i = 0; i < 45; i += 1) {
      const repository = i % 3 === 0 ? 'app' : `hidden${i % 7}`;
      await history.record(
        recordInput({
          workspaceId: ws,
          userId: users.member!,
          repository,
          pullRequestNumber: i + 1,
        }),
      );
    }
    const rows = await prisma.prReviewReport.findMany({
      where: { workspaceId: ws, repository: 'app' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    expected.push(...rows.map((r) => r.id));
    const result = await walk(users.member!, ws, '', 4);
    expect(result.ids).toEqual(expected);
    // Filters combine with authorization.
    const filtered = await walk(
      users.member!,
      ws,
      '&owner=acme&repository=app&pullRequestNumber=4',
    );
    expect(filtered.ids).toEqual([rows.find((r) => r.pullRequestNumber === 4)!.id]);
  });

  it('a GitHub outage stops the page before the undecided report instead of hiding it', async () => {
    const { ws, users } = await seed({
      roles: { member: 'member' },
      installation: ['acme/app', 'acme/flaky'],
    });
    await history.record(
      recordInput({ workspaceId: ws, userId: users.member!, repository: 'app' }),
    ); // oldest
    await history.record(
      recordInput({ workspaceId: ws, userId: users.member!, repository: 'flaky' }),
    );
    await history.record(
      recordInput({ workspaceId: ws, userId: users.member!, repository: 'app' }),
    ); // newest
    const ids = (
      await prisma.prReviewReport.findMany({
        where: { workspaceId: ws },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      })
    ).map((r) => r.id);

    FLAKY_REPOS.add('acme/flaky');
    try {
      const page = await call(users.member!, `/workspaces/${ws}/pr-reviews?limit=10`);
      expect(page.status).toBe(200);
      expect((page.body.items as Array<{ id: string }>).map((i) => i.id)).toEqual([ids[0]]);
      expect(page.body.accessCheckIncomplete).toBe(true);
      expect(page.body.nextCursor).toBeTruthy();
      // Continuing while GitHub is still down: nothing decidable → 503, not an empty "end".
      const stuck = await call(
        users.member!,
        `/workspaces/${ws}/pr-reviews?limit=10&cursor=${page.body.nextCursor as string}`,
      );
      expect(stuck.status).toBe(503);
      expect(JSON.stringify(stuck.body)).not.toMatch(/\b502\b|Bad gateway|ghs_/);

      FLAKY_REPOS.delete('acme/flaky');
      const resumed = await call(
        users.member!,
        `/workspaces/${ws}/pr-reviews?limit=10&cursor=${page.body.nextCursor as string}`,
      );
      expect((resumed.body.items as Array<{ id: string }>).map((i) => i.id)).toEqual([
        ids[1],
        ids[2],
      ]);
      expect(resumed.body.nextCursor).toBeNull();
    } finally {
      FLAKY_REPOS.delete('acme/flaky');
    }
  });

  // ── persistence status: truthful, observable, no internal errors leaked ──

  it('the JSON review response reports the database-confirmed history status', async () => {
    const { ws, users } = await seed({ roles: { owner: 'owner' } });
    diff.resolve.mockResolvedValue(oneFile());
    const result = await aiService().generateActionWithMetadata(users.owner!, reviewInput());
    const row = await prisma.prReviewReport.findFirstOrThrow({ where: { workspaceId: ws } });
    expect(result.reviewHistory).toEqual({ status: 'saved', reportId: row.id });
  });

  it('persistence failures are logged with codes only, counted, and reported as not saved', async () => {
    const { ws, users } = await seed({ roles: { owner: 'owner' } });
    const metrics = {
      recordPrReviewHistoryWrite: vi.fn(),
      recordPrReviewHistoryAccessCheck: vi.fn(),
    };
    const errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const failing = new PrReviewHistoryService(
        {
          prReviewReport: {
            create: vi.fn(async () => {
              throw new Prisma.PrismaClientKnownRequestError(
                'insert into "pr_review_reports" value=SECRET_PAYLOAD failed',
                { code: 'P2000', clientVersion: 'x' },
              );
            }),
          },
        } as never,
        {} as never,
        {} as never,
        requestContext,
        metrics as never,
      );
      const input = recordInput({ workspaceId: ws, userId: users.owner! });
      expect(await failing.record(input)).toEqual({ status: 'not_saved' });
      expect(metrics.recordPrReviewHistoryWrite).toHaveBeenCalledWith(
        'failed',
        'completed',
        expect.any(Number),
      );
      const logged = JSON.stringify(errorLog.mock.calls);
      expect(logged).toContain('pr_review_history.persist_failed');
      expect(logged).toContain(input.operationId);
      expect(logged).toContain('P2000');
      expect(logged).not.toContain('SECRET_PAYLOAD');
      expect(logged).not.toContain('insert into');

      // Duplicate that cannot be re-read → "unknown", never "saved".
      const unconfirmed = new PrReviewHistoryService(
        {
          prReviewReport: {
            create: vi.fn(async () => {
              throw new Prisma.PrismaClientKnownRequestError('dup', {
                code: 'P2002',
                clientVersion: 'x',
              });
            }),
            findUnique: vi.fn(async () => {
              throw new Error('connection reset');
            }),
          },
        } as never,
        {} as never,
        {} as never,
        requestContext,
        metrics as never,
      );
      expect(await unconfirmed.record(input)).toEqual({ status: 'unknown' });
      expect(metrics.recordPrReviewHistoryWrite).toHaveBeenCalledWith(
        'unconfirmed',
        'completed',
        expect.any(Number),
      );

      // Real database: created, then duplicate — both confirmed.
      const real = new PrReviewHistoryService(
        prisma as never,
        {} as never,
        {} as never,
        requestContext,
        metrics as never,
      );
      const saved = await real.record(input);
      expect(saved.status).toBe('saved');
      expect(await real.record(input)).toEqual(saved);
      expect(metrics.recordPrReviewHistoryWrite).toHaveBeenCalledWith(
        'created',
        'completed',
        expect.any(Number),
      );
      expect(metrics.recordPrReviewHistoryWrite).toHaveBeenCalledWith(
        'duplicate',
        'completed',
        expect.any(Number),
      );
    } finally {
      errorLog.mockRestore();
    }
  });

  it('operation status: confirmed from PostgreSQL, initiator only, workspace-scoped', async () => {
    const { ws, users } = await seed({
      roles: { owner: 'owner', member: 'member' },
      installation: ['acme/app'],
    });
    const other = await seed({ roles: { owner: 'owner' } });
    const input = recordInput({ workspaceId: ws, userId: users.member! });
    await history.record(input);
    const row = await prisma.prReviewReport.findFirstOrThrow({ where: { workspaceId: ws } });
    const path = `/workspaces/${ws}/pr-reviews/operations/${input.operationId}`;

    expect((await call(users.member!, path)).body).toEqual({ status: 'saved', reportId: row.id });
    expect((await call(users.owner!, path)).body).toEqual({ status: 'not_saved' });
    expect(
      (
        await call(
          users.member!,
          `/workspaces/${ws}/pr-reviews/operations/11111111-1111-4111-8111-111111111111`,
        )
      ).body,
    ).toEqual({ status: 'not_saved' });
    expect(
      (await call(users.member!, `/workspaces/${ws}/pr-reviews/operations/not-a-uuid`)).body,
    ).toEqual({
      status: 'not_saved',
    });
    expect((await call(other.users.owner!, path)).status).toBe(403);
    expect(githubCalls).toHaveLength(0);
  });

  // ── authorization cache: revocation, credential changes, isolation ───────

  const listIds = async (user: string, ws: string) =>
    (
      (await call(user, `/workspaces/${ws}/pr-reviews?limit=50`)).body.items as Array<{
        id: string;
      }>
    ).map((i) => i.id);
  const openStatus = async (user: string, ws: string, id: string) =>
    (await call(user, `/workspaces/${ws}/pr-reviews/${id}`)).status;
  const latestStatus = async (user: string, ws: string) =>
    (
      await call(
        user,
        `/workspaces/${ws}/pr-reviews/latest?owner=acme&repository=app&pullRequestNumber=1`,
      )
    ).status;

  async function reportIn(ws: string, userId: string, repository = 'app') {
    await history.record(recordInput({ workspaceId: ws, userId, repository }));
    return (
      await prisma.prReviewReport.findFirstOrThrow({
        where: { workspaceId: ws, repository },
        orderBy: { createdAt: 'desc' },
      })
    ).id;
  }

  it('GitHub App removed or suspended: cached access is void immediately (list, detail, latest)', async () => {
    const { ws, users } = await seed({
      roles: { owner: 'owner', member: 'member' },
      installation: ['acme/app'],
    });
    const id = await reportIn(ws, users.owner!);
    expect(await listIds(users.member!, ws)).toEqual([id]); // warms the cache
    expect(await openStatus(users.member!, ws, id)).toBe(200);

    await prisma.gitHubAppInstallation.update({
      where: { workspaceId: ws },
      data: { status: 'suspended' },
    });
    // H1: without the App the user's own token decides — under a different credential
    // identity, so the App-era cached "allowed" is never reused. This member's own token
    // cannot see the repository: denied by a fresh check.
    PATS[users.member!] = `ghp_none_${Date.now()}`;
    githubCalls.length = 0;
    expect(await listIds(users.member!, ws)).toEqual([]);
    expect(await openStatus(users.member!, ws, id)).toBe(404);
    expect(await latestStatus(users.member!, ws)).toBe(404);
    expect(githubCalls.length).toBeGreaterThan(0); // decided live, not from the stale entry

    await prisma.gitHubAppInstallation.update({
      where: { workspaceId: ws },
      data: { status: 'removed' },
    });
    // The owner's own token can read the repository: still exactly what GitHub grants them.
    expect(await listIds(users.owner!, ws)).toEqual([id]);
    expect(await openStatus(users.owner!, ws, id)).toBe(200);
  });

  it('GitHub App relinked to another installation: answers of the old installation are not reused', async () => {
    const { ws, users } = await seed({ roles: { member: 'member' }, installation: ['acme/app'] });
    const id = await reportIn(ws, users.member!);
    expect(await listIds(users.member!, ws)).toEqual([id]);
    const replacement = `7${Date.now() % 1_000_000}`;
    INSTALLATION_REPOS[replacement] = ['acme/other']; // the new installation cannot see acme/app
    await prisma.gitHubAppInstallation.update({
      where: { workspaceId: ws },
      data: { installationId: replacement },
    });
    expect(await listIds(users.member!, ws)).toEqual([]);
    expect(await openStatus(users.member!, ws, id)).toBe(404);
  });

  it('personal token disconnected or replaced: cached access follows the current token at once', async () => {
    const { ws, users } = await seed({ roles: { owner: 'owner' }, withPat: ['owner'] }); // no App
    const id = await reportIn(ws, users.owner!);
    const original = PATS[users.owner!]!;
    expect(await listIds(users.owner!, ws)).toEqual([id]);

    delete PATS[users.owner!]; // disconnected
    expect(await listIds(users.owner!, ws)).toEqual([]);
    expect(await openStatus(users.owner!, ws, id)).toBe(404);

    PATS[users.owner!] = `ghp_none_${Date.now()}`; // replaced by a token without access
    expect(await listIds(users.owner!, ws)).toEqual([]);
    expect(await openStatus(users.owner!, ws, id)).toBe(404);

    PATS[users.owner!] = original; // a token with access again: the "denied" is not reused either
    expect(await listIds(users.owner!, ws)).toEqual([id]);
    expect(await openStatus(users.owner!, ws, id)).toBe(200);
  });

  it('revoked on GitHub with the same credential: content is denied at once, list metadata within the TTL', async () => {
    const { ws, users } = await seed({ roles: { member: 'member' }, installation: ['acme/app'] });
    const id = await reportIn(ws, users.member!);
    expect(await listIds(users.member!, ws)).toEqual([id]);
    expect(await openStatus(users.member!, ws, id)).toBe(200);

    // The repository is removed from the installation on GitHub (no webhook handled).
    const installationId = (
      await prisma.gitHubAppInstallation.findUniqueOrThrow({ where: { workspaceId: ws } })
    ).installationId;
    INSTALLATION_REPOS[installationId] = [];
    // Report content (findings, evidence) is never served from a cached "allowed".
    expect(await openStatus(users.member!, ws, id)).toBe(404);
    expect(await latestStatus(users.member!, ws)).toBe(404);
    // The live "denied" was cached, so the list drops it immediately as well.
    expect(await listIds(users.member!, ws)).toEqual([]);
  });

  it('list-only cached "allowed" expires within 60 seconds', async () => {
    const { ws, users } = await seed({ roles: { member: 'member' }, installation: ['acme/app'] });
    const id = await reportIn(ws, users.member!);
    expect(await listIds(users.member!, ws)).toEqual([id]); // cached "allowed"
    const installationId = (
      await prisma.gitHubAppInstallation.findUniqueOrThrow({ where: { workspaceId: ws } })
    ).installationId;
    INSTALLATION_REPOS[installationId] = [];
    try {
      cache.offsetMs = 30_000;
      expect(await listIds(users.member!, ws)).toEqual([id]); // within the TTL: metadata only
      cache.offsetMs = 61_000;
      expect(await listIds(users.member!, ws)).toEqual([]);
    } finally {
      cache.offsetMs = 0;
    }
  });

  it('opening a report always re-checks GitHub; listing reuses the cache', async () => {
    const { ws, users } = await seed({ roles: { member: 'member' }, installation: ['acme/app'] });
    const id = await reportIn(ws, users.member!);
    githubCalls.length = 0;
    await listIds(users.member!, ws);
    await listIds(users.member!, ws);
    // H1: one decision = the user's own permission + the App's view (2 calls), then cached.
    expect(githubCalls).toHaveLength(2);
    await openStatus(users.member!, ws, id);
    await openStatus(users.member!, ws, id);
    expect(githubCalls).toHaveLength(6);
    expect(githubCalls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('H1: an App-only viewer (no personal token) sees nothing, even in installed repositories', async () => {
    const { ws, users } = await seed({
      roles: { owner: 'owner', member: 'member' },
      installation: ['acme/app'],
      withPat: ['owner'],
    });
    const id = await reportIn(ws, users.owner!);
    expect(await listIds(users.owner!, ws)).toEqual([id]); // verified identity: visible
    githubCalls.length = 0;
    expect(await listIds(users.member!, ws)).toEqual([]);
    expect(await openStatus(users.member!, ws, id)).toBe(404);
    expect(await latestStatus(users.member!, ws)).toBe(404);
    expect(githubCalls.some((c) => c.url.includes('/repos/acme/app'))).toBe(false); // App unused
  });

  it('cached access never crosses workspaces or users', async () => {
    const a = await seed({
      roles: { owner: 'owner', member: 'member' },
      installation: ['acme/app'],
    });
    // B's App installation does not cover acme/app: the same user is allowed in A, not in B.
    const b = await seed({ roles: { owner: 'owner' }, installation: ['acme/other'] });
    // The same person is a member of both workspaces; both have a report for acme/app.
    await prisma.workspaceMembership.create({
      data: { workspaceId: b.ws, userId: a.users.member!, role: 'member', status: 'active' },
    });
    await reportIn(a.ws, a.users.owner!);
    const inB = await reportIn(b.ws, b.users.owner!);
    expect((await listIds(a.users.member!, a.ws)).length).toBe(1); // warm A's cache for this user
    expect(await listIds(a.users.member!, b.ws)).toEqual([]);
    expect(await openStatus(a.users.member!, b.ws, inB)).toBe(404);
    // Another member of A does not inherit this user's cache entry either (own lookup).
    githubCalls.length = 0;
    expect((await listIds(a.users.owner!, a.ws)).length).toBe(1);
    expect(githubCalls).toHaveLength(2); // own lookup: own permission + App view
  });

  it('cache keys are versioned digests: no token, user id, workspace id or repository in clear', async () => {
    const { ws, users } = await seed({ roles: { owner: 'owner' }, withPat: ['owner'] });
    await reportIn(ws, users.owner!);
    cache.store.clear();
    await listIds(users.owner!, ws);
    const keys = [...cache.store.keys()];
    expect(keys).toHaveLength(1);
    // Plain, non-secret components (ids, connection version, repository): no token, and no
    // hashing of anything credential-derived.
    expect(keys[0]).toMatch(/^px:prh:access:v3:/);
    expect(keys[0]).not.toContain(PATS[users.owner!]!);
    expect(keys[0]).not.toMatch(/ghp_|ghs_/);
    expect(keys[0]).toContain(':pat%3Aconn_');
  });

  it('GitHubConnection version (real table): changes on replace, gone on disconnect, new on reconnect', async () => {
    const { GithubConnectionService } =
      await import('../../src/settings/github-connection.service');
    const connections = new GithubConnectionService(
      prisma as never,
      { getOrThrow: () => ENCRYPTION_KEY, get: () => ENCRYPTION_KEY } as never,
    );
    const { users } = await seed({ roles: { owner: 'owner' } });
    const userId = users.owner!;
    await prisma.gitHubConnection.create({
      data: { userId, tokenCiphertext: encryptSecret('ghp_first_value', ENCRYPTION_KEY) },
    });
    const first = await connections.getConnectionVersion(userId);
    expect(first).toMatch(/^c[a-z0-9]+:\d+$/);
    expect(await connections.getDecryptedToken(userId)).toBe('ghp_first_value');
    await new Promise((r) => setTimeout(r, 5));
    // Same write the settings flow performs when a token is replaced (upsert → update).
    await prisma.gitHubConnection.update({
      where: { userId },
      data: { tokenCiphertext: encryptSecret('ghp_second_value', ENCRYPTION_KEY) },
    });
    const second = await connections.getConnectionVersion(userId);
    expect(second).not.toBe(first);
    await connections.disconnect(userId);
    expect(await connections.getConnectionVersion(userId)).toBeNull();
    await prisma.gitHubConnection.create({
      data: { userId, tokenCiphertext: encryptSecret('ghp_second_value', ENCRYPTION_KEY) },
    });
    const third = await connections.getConnectionVersion(userId);
    expect(third).not.toBe(second); // same token reconnected → new row, new version
    for (const version of [first, second, third]) {
      expect(version).not.toMatch(/ghp_/);
    }
  });

  it('an answer is not cached when the credential changes during the GitHub lookup', async () => {
    const { ws, users } = await seed({ roles: { owner: 'owner' }, withPat: ['owner'] });
    const id = await reportIn(ws, users.owner!);
    const userId = users.owner!;
    const original = PATS[userId]!;
    // While GitHub is being asked (with the original token), the user replaces the token.
    const realFetchStub = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith('https://api.github.com/'))
        PATS[userId] = `ghp_none_${Date.now()}`;
      return realFetchStub(input, init);
    }) as typeof fetch;
    try {
      cache.store.clear();
      expect(await openStatus(userId, ws, id)).toBe(200); // answered for the original token
      expect(cache.store.size).toBe(0); // …but not cached under either identity
    } finally {
      globalThis.fetch = realFetchStub;
      PATS[userId] = original;
    }
  });
});
