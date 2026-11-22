/**
 * PR Review × deterministic downstream impact — PostgreSQL acceptance tests, MOCKED GitHub.
 *
 * Real: AiService PR Review path (planner, orchestrator, usage), PrReviewImpactService,
 * PullRequestDiffService.fetchFileAtRef (SHA-pinned reads), Phase 1 diff + impact,
 * ContractImpactService (scoped graph, personal-token access checks), PrReviewHistoryService
 * (record + read-time re-authorization), UsageService, EntitlementService, FeatureGate.
 * Stubbed: the model (`ai.generateText`), the PR file listing, api.github.com responses.
 * No real GitHub or AI request is made.
 */
import { PrismaClient } from '@prisma/client';
import { usagePeriodKey } from '@project-x/shared';
import { AIAction, type PrReviewDownstreamImpact } from '@project-x/types';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AiService } from '../../src/ai/ai.service';
import { makeFile, makePatch } from '../../src/ai/pr-review/pr-review-fixtures';
import { PrReviewImpactService } from '../../src/ai/pr-review/pr-review-impact.service';
import { PrReviewOrchestrator } from '../../src/ai/pr-review/pr-review-orchestrator.service';
import { PullRequestDiffService } from '../../src/ai/pr-review/pull-request-diff.service';
import { PromptRegistry } from '../../src/ai/prompts/prompt.registry';
import { ContractImpactService } from '../../src/contract-impact/contract-impact.service';
import { EntitlementService } from '../../src/entitlements/entitlements.service';
import { FeatureGate } from '../../src/entitlements/feature-gate';
import { RequestContextService } from '../../src/observability/request-context.service';
import { PrReviewHistoryService } from '../../src/pr-review-history/pr-review-history.service';
import { UsageService } from '../../src/usage/usage.service';
import { WorkspaceAuthorizationService } from '../../src/workspaces/workspace-authorization.service';

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
const OWNER = 'gh0st-000';
const API = 'project-x-test-api';
const CLIENT = 'project-x-test-client';
const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
const ok = () => ({
  output: { summary: 'fine', findings: [] },
  finishReason: 'stop',
  usage: { inputTokens: 800, outputTokens: 60, totalTokens: 860 },
});

const contract = (userFields: string, extraPaths = '') => `openapi: 3.0.3
info:
  title: ${API}
  version: 1.0.0
paths:
  /health:
    get:
      responses:
        '200':
          description: OK
  /api/users:
    get:
      responses:
        '200':
          description: All users
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/UsersResponse'
  /api/users/{id}:
    get:
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      responses:
        '200':
          description: One user
          content:
            application/json:
              schema:
                type: object
                properties:
                  user:
                    $ref: '#/components/schemas/User'
${extraPaths}components:
  schemas:
    User:
      type: object
      properties:
        id: { type: string }
${userFields}
    UsersResponse:
      type: object
      properties:
        users:
          type: array
          items:
            $ref: '#/components/schemas/User'
`;
const NAME = '        name: { type: string }';
const DISPLAY = '        displayName: { type: string }';
const BASE_DOC = contract(NAME);
const HEAD_DOC = contract(DISPLAY);

// ── fake api.github.com ─────────────────────────────────────────────────────────────────
type Contents = Record<string, string | number>; // `${sha}:${path}` → body or HTTP status
let contents: Contents = {};
let repoStatus: Record<string, number> = {};
let calls: string[] = [];
const realFetch = globalThis.fetch;

async function fakeGithub(input: string | URL | Request): Promise<Response> {
  const url = new URL(String(input));
  if (url.hostname !== 'api.github.com') throw new Error(`Unexpected request: ${url.href}`);
  calls.push(`${url.pathname}${url.search}`);
  const m = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)(?:\/contents\/(.+))?$/);
  if (!m) return new Response('{}', { status: 404 });
  const repo = `${decodeURIComponent(m[1]!)}/${decodeURIComponent(m[2]!)}`.toLowerCase();
  if (m[3] === undefined) {
    const status = repoStatus[repo] ?? 200;
    return status === 200 ? Response.json({ full_name: repo }) : new Response('{}', { status });
  }
  const key = `${url.searchParams.get('ref')}:${decodeURIComponent(m[3])}`;
  const body = contents[key];
  if (body === undefined) return new Response('{}', { status: 404 });
  if (typeof body === 'number') {
    return new Response('{}', {
      status: body,
      ...(body === 429 ? { headers: { 'retry-after': '60' } } : {}),
    });
  }
  return new Response(body, { status: 200 });
}

describe.skipIf(!URL_ENV)('PR Review downstream impact (PostgreSQL, mocked GitHub)', () => {
  let prisma: PrismaClient;
  let usage: UsageService;
  let history: PrReviewHistoryService;
  let run = 0;
  const pats = new Map<string, string>();
  const diff = { resolve: vi.fn(), createFileProvider: vi.fn(() => undefined) };
  const requestContext = new RequestContextService();

  // Credentials: the workspace/PR credential (PR diff + contract reads) and each user's own
  // personal token (consumer re-authorization) are distinct, like in production.
  const githubAccess = {
    // Repository reads (PR diff, contracts): the repository-scoped credential (H1-checked in
    // production; covered by github-repository-authorization.pg.spec.ts).
    resolveRepositoryAccess: async (userId: string) => ({
      ok: true,
      token: `ghs_pr_${userId}`,
      source: 'installation',
      workspaceId: 'ws',
    }),
    resolveCredentialIdentity: async (userId: string) => `id:${userId}`,
    // Consumer visibility: the user's OWN personal token only.
    getPersonalToken: async (userId: string) => pats.get(userId) ?? null,
    getDecryptedToken: async (userId: string) => pats.get(userId) ?? null,
  };

  beforeAll(async () => {
    const url = new URL(URL_ENV!);
    if (!url.pathname.endsWith('_it') || url.port === '5432') {
      throw new Error(`Refusing to run integration tests against ${url.host}${url.pathname}`);
    }
    prisma = new PrismaClient({ datasourceUrl: URL_ENV });
    await prisma.$connect();
    usage = new UsageService(prisma as never, new EntitlementService(prisma as never));
    const contractImpact = new ContractImpactService(
      prisma as never,
      githubAccess as never,
      new WorkspaceAuthorizationService(prisma as never),
    );
    history = new PrReviewHistoryService(
      prisma as never,
      githubAccess as never,
      { get: vi.fn(async () => null), set: vi.fn(async () => 'OK') } as never,
      requestContext,
      undefined,
      contractImpact,
    );
    globalThis.fetch = fakeGithub as typeof fetch;
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await prisma?.$disconnect();
  });

  beforeEach(() => {
    generateTextMock.mockReset().mockImplementation(async () => ok());
    diff.resolve.mockReset();
    contents = { [`${BASE_SHA}:openapi.yaml`]: BASE_DOC, [`${HEAD_SHA}:openapi.yaml`]: HEAD_DOC };
    repoStatus = {};
    calls = [];
  });
  afterEach(() => vi.useRealTimers());

  function service() {
    const realDiff = new PullRequestDiffService(githubAccess as never);
    const diffLike = Object.assign(diff, {
      fetchFileAtRef: realDiff.fetchFileAtRef.bind(realDiff),
    });
    const contractImpact = new ContractImpactService(
      prisma as never,
      githubAccess as never,
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
      new FeatureGate(new EntitlementService(prisma as never)),
      usage,
      obs as never,
      { get: () => ({}), patch: vi.fn() } as never,
      health as never,
      undefined,
      undefined,
      diffLike as never,
      new PrReviewOrchestrator(modelFactory as never, obs as never, health as never),
      history,
      new PrReviewImpactService(diffLike as never, contractImpact),
    );
  }

  const input = {
    action: AIAction.REVIEW_ENTIRE_PR,
    text: 'Review this PR.',
    context: {
      type: 'github',
      url: `https://github.com/${OWNER}/${API}/pull/7`,
      title: 'PR',
      github: { owner: OWNER, repository: API, pullRequestNumber: 7 },
    },
  } as never;

  const prDiff = (
    files = [makeFile('openapi.yaml', makePatch(6)), makeFile('src/data/users.ts', makePatch(4))],
  ) => ({
    source: 'github_api',
    files,
    totalFiles: files.length,
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
  });

  async function member(ws: string, withPat = true) {
    run += 1;
    const user = `pri_user_${run}_${Date.now()}`;
    await prisma.user.create({
      data: { id: user, email: `${user}@it.test`, passwordHash: 'x', lastWorkspaceId: ws },
    });
    await prisma.workspaceMembership.create({
      data: { workspaceId: ws, userId: user, role: 'owner', status: 'active' },
    });
    if (withPat) pats.set(user, `ghp_${user}`);
    return user;
  }

  /** Workspace on the team plan, a System with both repos, and the reviewer's real graph. */
  async function seed(
    opts: { system?: boolean; relationships?: boolean; validatedAt?: Date } = {},
  ) {
    run += 1;
    const ws = `ws_pri_${run}_${Date.now()}`;
    await prisma.workspace.create({ data: { id: ws, name: ws, slug: ws } });
    await prisma.workspaceSubscription.create({
      data: { workspaceId: ws, provider: 'paddle', planId: 'team', status: 'active' },
    });
    const user = await member(ws);
    let systemId: string | undefined;
    if (opts.system !== false) {
      const system = await prisma.projectSystem.create({
        data: {
          userId: user,
          workspaceId: ws,
          name: 'Test Microservices',
          primaryOwner: OWNER,
          primaryRepository: API,
          repositories: {
            create: [
              { owner: OWNER, repository: API },
              { owner: OWNER, repository: CLIENT },
              { owner: 'acme', repository: 'billing-web' },
            ],
          },
        },
      });
      systemId = system.id;
      if (opts.relationships !== false)
        await graph(user, ws, system.id, opts.validatedAt ?? new Date());
    }
    return { ws, user, systemId };
  }

  async function graph(user: string, ws: string, systemId: string, at: Date) {
    const row = (
      from: string,
      to: string,
      type: string,
      key: string,
      extra: Record<string, unknown> = {},
    ) => ({
      userId: user,
      workspaceId: ws,
      systemId,
      fromOwner: from === 'billing-web' ? 'acme' : OWNER,
      fromRepository: from,
      toOwner: OWNER,
      toRepository: to,
      type,
      resourceKind: 'http_operation',
      resourceKey: key,
      confidence: 'high',
      status: 'active',
      lastValidatedAt: at,
      provenanceJson: [
        {
          type: 'http_call',
          repository: from,
          filePath: 'src/userApiClient.ts',
          summary: `${key} via baseUrl (line 51)`,
          observedAt: at.toISOString(),
        },
        {
          type: 'openapi_reference',
          repository: API,
          filePath: 'openapi.yaml',
          summary: `OpenAPI ${key}`,
          observedAt: at.toISOString(),
        },
        {
          type: 'http_call',
          repository: API,
          filePath: 'src/routes/users.ts',
          summary: `Route ${key}`,
          observedAt: at.toISOString(),
        },
      ],
      ...extra,
    });
    await prisma.repositoryRelationship.createMany({
      data: [
        row(CLIENT, API, 'HTTP_CALLS', 'GET /health'),
        row(CLIENT, API, 'HTTP_CALLS', 'GET /api/users'),
        row(CLIENT, API, 'HTTP_CALLS', 'GET /api/users/{param}'),
        row(API, API, 'PROVIDES_API', 'GET /api/users'),
        row(CLIENT, API, 'HTTP_CALLS', 'GET /api/users', {
          resourceKind: 'service',
          resourceKey: `${OWNER}/${API}`,
          confidence: 'low',
          status: 'superseded',
        }),
        // Another consumer of ANOTHER provider: must never appear.
        {
          ...row('billing-web', 'project-x-orders', 'HTTP_CALLS', 'GET /api/users'),
          toOwner: 'acme',
        },
      ],
    });
  }

  const usageUnits = async (ws: string) =>
    (
      await prisma.workspaceUsageCounter.findMany({
        where: { workspaceId: ws, periodKey: usagePeriodKey() },
      })
    ).reduce((n, r) => n + r.count, 0);
  const reportOf = (ws: string) =>
    prisma.prReviewReport.findFirstOrThrow({ where: { workspaceId: ws } });

  // ── acceptance ──────────────────────────────────────────────────────────────────────────

  it('ACCEPTANCE: users[].name removed → project-x-test-client potentially affected; /health not flagged', async () => {
    const { ws, user, systemId } = await seed();
    diff.resolve.mockResolvedValue(prDiff());
    const result = await service().generateActionWithMetadata(user, input);
    const impact = result.downstreamImpact!;

    // Contracts were read at the immutable PR SHAs only.
    const reads = calls.filter((c) => c.includes('/contents/'));
    expect(reads.sort()).toEqual([
      `/repos/${OWNER}/${API}/contents/openapi.yaml?ref=${BASE_SHA}`,
      `/repos/${OWNER}/${API}/contents/openapi.yaml?ref=${HEAD_SHA}`,
    ]);
    expect(impact).toMatchObject({
      status: 'verified',
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
      withheldConsumers: 0,
      warnings: [],
    });
    expect(impact.contracts).toEqual([
      { path: 'openapi.yaml', status: 'compared', breaking: 2, nonBreaking: 2, uncertain: 0 },
    ]);
    expect(impact.findings.map((f) => [f.operation, f.fieldPath])).toEqual([
      ['GET /api/users', 'users[].name'],
      ['GET /api/users/{param}', 'user.name'],
    ]);
    for (const f of impact.findings) {
      expect(
        f.consumers.map((c) => [c.repository.repository, c.confidence, c.systems[0]?.id]),
      ).toEqual([[CLIENT, 'high', systemId]]);
      expect(f.consumers[0]!.evidence.map((e) => e.filePath)).toEqual([
        'src/userApiClient.ts',
        'openapi.yaml',
        'src/routes/users.ts',
      ]);
    }
    expect(JSON.stringify(impact)).not.toContain('billing-web');
    expect(impact.findings.some((f) => f.operation === 'GET /health')).toBe(false);

    // Live text: the section first (older clients ignore text before "## Summary").
    expect(result.text.startsWith('## Downstream Impact')).toBe(true);
    expect(result.text).toContain(
      'Potentially affected: gh0st-000/project-x-test-client — confidence High',
    );
    expect(result.text).toContain('not a confirmed runtime failure');
    expect(result.text.indexOf('## Downstream Impact')).toBeLessThan(
      result.text.indexOf('## Summary'),
    );

    // No extra AI call, one usage unit (the review itself).
    expect(generateTextMock.mock.calls.length).toBe(result.coverage!.batches.length);
    expect(await usageUnits(ws)).toBe(1);

    // Review History: structured impact saved; the shared Markdown carries no consumer names.
    const row = await reportOf(ws);
    expect(row.reportMarkdown).not.toContain(CLIENT);
    expect(row.reportMarkdown).not.toContain('Downstream Impact');
    const saved = await history.get(user, ws, row.id);
    expect(saved.snapshot.downstreamImpact!.findings[0]!.consumers[0]!.repository.repository).toBe(
      CLIENT,
    );
    expect(saved.snapshot.downstreamImpact!.analyzedAt).toBe(impact.analyzedAt);
    // Viewing history performs access checks only: no contract reads, no AI, no usage.
    calls = [];
    await history.get(user, ws, row.id);
    expect(calls.some((c) => c.includes('/contents/'))).toBe(false);
    expect(await usageUnits(ws)).toBe(1);
  });

  // ── contract states ─────────────────────────────────────────────────────────────────────

  it('no OpenAPI change: no contract reads, no section, status not_analyzed', async () => {
    const { user } = await seed();
    diff.resolve.mockResolvedValue(prDiff([makeFile('src/a.ts', makePatch(5))]));
    const result = await service().generateActionWithMetadata(user, input);
    expect(result.downstreamImpact!.status).toBe('not_analyzed');
    expect(calls.filter((c) => c.includes('/contents/'))).toEqual([]);
    expect(result.text).not.toContain('Downstream Impact');
  });

  it('documentation-only and additive changes are compatible', async () => {
    const { user } = await seed();
    contents[`${HEAD_SHA}:openapi.yaml`] = contract(
      `${NAME}\n        email: { type: string }`,
    ).replace('description: All users', 'description: Every user');
    diff.resolve.mockResolvedValue(prDiff());
    const impact = (await service().generateActionWithMetadata(user, input)).downstreamImpact!;
    expect(impact).toMatchObject({ status: 'compatible', findings: [] });
    expect(impact.contracts[0]).toMatchObject({ breaking: 0, nonBreaking: 2 });
  });

  it('a removed endpoint is a breaking finding for its callers', async () => {
    const { user } = await seed();
    contents[`${HEAD_SHA}:openapi.yaml`] = BASE_DOC.replace(
      / {2}\/api\/users\/\{id\}:[\s\S]*?(?=components:)/,
      '',
    );
    diff.resolve.mockResolvedValue(prDiff());
    const impact = (await service().generateActionWithMetadata(user, input)).downstreamImpact!;
    expect(impact.findings.map((f) => [f.kind, f.operation, f.consumers.length])).toEqual([
      ['removed-endpoint', 'GET /api/users/{param}', 1],
    ]);
  });

  it('a renamed contract is compared against its previous path', async () => {
    const { user } = await seed();
    contents = {
      [`${BASE_SHA}:openapi.yaml`]: BASE_DOC,
      [`${HEAD_SHA}:api/openapi.yaml`]: HEAD_DOC,
    };
    diff.resolve.mockResolvedValue(
      prDiff([
        makeFile('api/openapi.yaml', makePatch(3), {
          status: 'renamed',
          previousPath: 'openapi.yaml',
        }),
      ]),
    );
    const impact = (await service().generateActionWithMetadata(user, input)).downstreamImpact!;
    expect(impact.status).toBe('verified');
    expect(impact.contracts[0]).toMatchObject({
      path: 'api/openapi.yaml',
      previousPath: 'openapi.yaml',
      status: 'compared',
    });
  });

  it('bounded: more than 3 changed contracts compares the first 3 and reports partial', async () => {
    const { user } = await seed();
    const files = ['a', 'b', 'c', 'd'].map((d) => makeFile(`${d}/openapi.yaml`, makePatch(2)));
    for (const d of ['a', 'b', 'c', 'd']) {
      contents[`${BASE_SHA}:${d}/openapi.yaml`] = BASE_DOC;
      contents[`${HEAD_SHA}:${d}/openapi.yaml`] = BASE_DOC;
    }
    diff.resolve.mockResolvedValue(prDiff(files));
    const impact = (await service().generateActionWithMetadata(user, input)).downstreamImpact!;
    expect(impact.contracts).toHaveLength(3);
    expect(impact.warnings).toContain('too_many_contracts');
    expect(impact.status).toBe('partial');
    expect(calls.filter((c) => c.includes('/contents/'))).toHaveLength(6);
  });

  it('malformed, missing and forbidden contracts are reported, never as "no impact"', async () => {
    const { user } = await seed();
    contents[`${HEAD_SHA}:openapi.yaml`] = 'openapi: 3.0.0\npaths: [not, a, map';
    diff.resolve.mockResolvedValue(prDiff());
    expect(
      (await service().generateActionWithMetadata(user, input)).downstreamImpact,
    ).toMatchObject({
      status: 'unavailable',
      warnings: ['contract_unparseable'],
    });
    contents[`${HEAD_SHA}:openapi.yaml`] = 403;
    expect(
      (await service().generateActionWithMetadata(user, input)).downstreamImpact,
    ).toMatchObject({
      status: 'unavailable',
      warnings: ['contract_unavailable'],
    });
    contents[`${HEAD_SHA}:openapi.yaml`] = 429;
    expect(
      (await service().generateActionWithMetadata(user, input)).downstreamImpact,
    ).toMatchObject({
      status: 'unavailable',
      warnings: ['rate_limited'],
    });
    // Base missing at the base commit: a new contract — additions only.
    contents = { [`${HEAD_SHA}:openapi.yaml`]: HEAD_DOC };
    expect(
      (await service().generateActionWithMetadata(user, input)).downstreamImpact,
    ).toMatchObject({
      status: 'compatible',
      contracts: [{ status: 'added' }],
    });
    // Deleted spec file: not treated as removal of every endpoint.
    diff.resolve.mockResolvedValue(
      prDiff([makeFile('openapi.yaml', makePatch(2), { status: 'removed' })]),
    );
    expect(
      (await service().generateActionWithMetadata(user, input)).downstreamImpact,
    ).toMatchObject({
      status: 'unavailable',
      warnings: ['contract_deleted'],
    });
  });

  it('page-fallback diffs (no verified SHAs) never read contracts', async () => {
    const { user } = await seed();
    diff.resolve.mockResolvedValue({
      source: 'page',
      files: [makeFile('openapi.yaml', makePatch(3))],
      totalFiles: null,
    });
    const impact = (await service().generateActionWithMetadata(user, input)).downstreamImpact!;
    expect(impact).toMatchObject({ status: 'unavailable', warnings: ['unverified_shas'] });
    expect(calls).toEqual([]);
  });

  // ── graph coverage ──────────────────────────────────────────────────────────────────────

  it('no relevant System, or no known consumers, is never presented as safe', async () => {
    const none = await seed({ system: false });
    diff.resolve.mockResolvedValue(prDiff());
    const a = await service().generateActionWithMetadata(none.user, input);
    expect(a.downstreamImpact!.status).toBe('no_system');
    expect(a.text).toContain('not in any of your Systems');
    const empty = await seed({ relationships: false });
    const b = await service().generateActionWithMetadata(empty.user, input);
    expect(b.downstreamImpact!.status).toBe('no_known_consumers');
    expect(b.text).toContain('this does not mean nothing depends on it');
  });

  it('disabled consumers and stale graphs', async () => {
    const { user, systemId } = await seed({ validatedAt: new Date('2026-01-01T00:00:00Z') });
    diff.resolve.mockResolvedValue(prDiff());
    const stale = (await service().generateActionWithMetadata(user, input)).downstreamImpact!;
    expect(stale.warnings).toContain('stale_graph');
    expect(stale.findings[0]!.consumers[0]!.stale).toBe(true);
    await prisma.projectSystemRepository.updateMany({
      where: { systemId, repository: CLIENT },
      data: { enabled: false },
    });
    const disabled = (await service().generateActionWithMetadata(user, input)).downstreamImpact!;
    expect(disabled.status).toBe('no_known_consumers');
  });

  // ── security ────────────────────────────────────────────────────────────────────────────

  it('revoked consumer access: the consumer is withheld (no name, no evidence), fail closed', async () => {
    const { user } = await seed();
    repoStatus[`${OWNER}/${CLIENT}`.toLowerCase()] = 404;
    diff.resolve.mockResolvedValue(prDiff());
    const result = await service().generateActionWithMetadata(user, input);
    const impact = result.downstreamImpact!;
    expect(impact.status).toBe('partial');
    expect(impact.withheldConsumers).toBe(1);
    expect(impact.warnings).toContain('consumers_withheld');
    expect(JSON.stringify(impact)).not.toContain(CLIENT);
    expect(result.text).not.toContain(CLIENT);
    // Access was checked with the reviewer's own token, never with another credential.
    expect(calls).toContain(`/repos/${OWNER}/${CLIENT}`);
  });

  it('no personal GitHub token: consumers are withheld, review still succeeds', async () => {
    const { user } = await seed();
    pats.delete(user);
    diff.resolve.mockResolvedValue(prDiff());
    const result = await service().generateActionWithMetadata(user, input);
    expect(result.coverage).toBeDefined();
    expect(result.downstreamImpact).toMatchObject({
      withheldConsumers: 1,
      warnings: expect.arrayContaining(['no_personal_token']),
    });
    expect(calls).not.toContain(`/repos/${OWNER}/${CLIENT}`);
  });

  it('history is re-authorized per viewer; other workspaces and old reviews stay safe', async () => {
    const { ws, user } = await seed();
    diff.resolve.mockResolvedValue(prDiff());
    await service().generateActionWithMetadata(user, input);
    const row = await reportOf(ws);

    // A teammate whose access to the consumer cannot be confirmed sees no consumer details.
    const teammate = await member(ws, false);
    const forTeammate = await history.get(teammate, ws, row.id);
    expect(JSON.stringify(forTeammate.snapshot.downstreamImpact)).not.toContain(CLIENT);
    expect(forTeammate.snapshot.downstreamImpact!.withheldConsumers).toBeGreaterThan(0);
    expect(forTeammate.snapshot.downstreamImpact!.warnings).toContain('no_personal_token');
    // After the reviewer loses access, their own history hides it too.
    repoStatus[`${OWNER}/${CLIENT}`.toLowerCase()] = 404;
    const revoked = await history.get(user, ws, row.id);
    expect(JSON.stringify(revoked.snapshot.downstreamImpact)).not.toContain(CLIENT);
    repoStatus = {};

    // Another workspace's graph is never used.
    const other = await seed({ relationships: false });
    await graph(
      user,
      ws,
      (await prisma.projectSystem.findFirstOrThrow({ where: { workspaceId: ws } })).id,
      new Date(),
    );
    const otherResult = await service().generateActionWithMetadata(other.user, input);
    expect(otherResult.downstreamImpact!.status).toBe('no_known_consumers');

    // A report recorded before this feature (no downstreamImpact) still reads fine.
    // (Rows are immutable, so a legacy-shaped row is inserted rather than edited.)
    const { snapshot } = row as unknown as { snapshot: Record<string, unknown> };
    const { downstreamImpact: _omitted, ...legacySnapshot } = snapshot;
    const legacy = await prisma.prReviewReport.create({
      data: {
        workspaceId: ws,
        userId: user,
        operationId: `legacy-${Date.now()}`,
        owner: OWNER,
        repository: API,
        pullRequestNumber: 6,
        status: 'completed',
        snapshot: legacySnapshot as never,
        reportMarkdown: '## Summary\nlegacy',
        startedAt: new Date(),
        completedAt: new Date(),
      },
    });
    const legacyDetail = await history.get(user, ws, legacy.id);
    expect(legacyDetail.snapshot.downstreamImpact).toBeUndefined();
    expect(legacyDetail.reportMarkdown).toContain('legacy');
  });

  it('REAL EXTENSION PATH: streamed review (POST /ai/actions/stream) carries the section; owner casing is irrelevant', async () => {
    const { ws, user, systemId } = await seed();
    // The real PR URL uses "GH0ST-000"; stored System/graph rows may use any casing.
    await prisma.projectSystemRepository.updateMany({
      where: { systemId, repository: API },
      data: { owner: 'GH0ST-000' },
    });
    await prisma.repositoryRelationship.updateMany({
      where: { systemId, toRepository: API },
      data: { toOwner: 'GH0ST-000' },
    });
    diff.resolve.mockResolvedValue(prDiff());
    const chunks: string[] = [];
    const response = {
      statusCode: 0,
      writableEnded: false,
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
      end(chunk?: string) {
        if (chunk) chunks.push(chunk);
        this.writableEnded = true;
      },
    };
    const upper = {
      action: AIAction.REVIEW_ENTIRE_PR,
      text: 'Review this PR.',
      context: {
        type: 'github',
        url: 'https://github.com/GH0ST-000/project-x-test-api/pull/1',
        title: 'PR',
        github: { owner: 'GH0ST-000', repository: API, pullRequestNumber: 1 },
      },
    } as never;
    await service().pipeActionStream(user, upper, response as never);
    const body = chunks.join('');
    expect(body.trimStart().startsWith('## Downstream Impact')).toBe(true);
    expect(body).toContain(
      'Potentially affected: gh0st-000/project-x-test-client — confidence High',
    );
    expect(body.indexOf('## Downstream Impact')).toBeLessThan(body.indexOf('## Summary'));
    expect(body).not.toContain('GET /health');
    const row = await reportOf(ws);
    expect(
      (row.snapshot as { downstreamImpact?: { status: string } }).downstreamImpact?.status,
    ).toBe('verified');
    expect(await usageUnits(ws)).toBe(1);
  });

  it('impact failures never fail the review (isolated, unavailable state)', async () => {
    const { ws, user } = await seed();
    diff.resolve.mockResolvedValue(prDiff());
    const broken = service();
    const impactService = (broken as unknown as { prReviewImpact: PrReviewImpactService })
      .prReviewImpact;
    vi.spyOn(impactService, 'analyze').mockRejectedValue(new Error('boom'));
    const result = await broken.generateActionWithMetadata(user, input);
    expect(result.coverage).toBeDefined();
    expect(result.downstreamImpact).toMatchObject<Partial<PrReviewDownstreamImpact>>({
      status: 'unavailable',
    });
    expect(await usageUnits(ws)).toBe(1);
  });
});
