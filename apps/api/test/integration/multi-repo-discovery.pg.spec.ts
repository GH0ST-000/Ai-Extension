/**
 * Systems relationship discovery — PostgreSQL acceptance tests with a MOCKED GitHub.
 *
 * Real: MultiRepoService (discovery, matching, persistence, lifecycle), RepositoryScanner,
 * UsageService, EntitlementService, FeatureGate, PrismaClient/PostgreSQL.
 * Mocked: api.github.com (fixtures shaped like gh0st-000/project-x-test-api and
 * gh0st-000/project-x-test-client), the user's GitHub token. No real GitHub request is made.
 */
import { PrismaClient } from '@prisma/client';
import { usagePeriodKey } from '@project-x/shared';
import type { RelationshipProvenance } from '@project-x/types';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { EntitlementService } from '../../src/entitlements/entitlements.service';
import { FeatureGate } from '../../src/entitlements/feature-gate';
import { MultiRepoService } from '../../src/multi-repo/multi-repo.service';
import { diffApiContracts } from '../../src/openapi/lib/diff';
import { normalizeOpenApiDocument } from '../../src/openapi/lib/normalize';
import { parseOpenApiRaw } from '../../src/openapi/lib/parse-raw';
import { UsageService } from '../../src/usage/usage.service';

const URL_ENV = process.env.MEMORY_IT_DATABASE_URL;
const OWNER = 'gh0st-000';
const API_REPO = 'project-x-test-api';
const CLIENT_REPO = 'project-x-test-client';

// ── fixtures (synthetic; shaped like the two private test repositories) ─────────────────
// Abridged but structurally faithful to the real repositories (verified from local clones):
// API — createApp() + factory-mounted users router + conventional OpenAPI 3.0.3 YAML;
// client — typed client with an injected fetch, a getJson(path) wrapper and an endpoint map.
const API_FILES: Record<string, string> = {
  'package.json': JSON.stringify({
    name: 'project-x-test-api',
    dependencies: { express: '^4.21.0' },
  }),
  'README.md': `# project-x-test-api\nConsumed by https://github.com/GH0ST-000/${CLIENT_REPO}\n`,
  'openapi.yaml': `openapi: 3.0.3
info:
  title: project-x-test-api
  version: 1.0.0
servers:
  - url: http://localhost:4001
    description: Local development
paths:
  /health:
    get:
      operationId: getHealth
      responses:
        '200':
          description: OK
  /api/users:
    get:
      operationId: listUsers
      responses:
        '200':
          description: OK
  /api/users/{id}:
    get:
      operationId: getUserById
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      responses:
        '200':
          description: OK
components:
  schemas:
    User:
      type: object
`,
  'src/app.ts': `import express, { type Express } from 'express';
import { createUsersRouter } from './routes/users.js';

export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.use('/api/users', createUsersRouter());
  app.use(notFoundHandler);
  return app;
}
`,
  'src/routes/users.ts': `import { Router } from 'express';
import { findUserById, listUsers } from '../data/users.js';

export function createUsersRouter(): Router {
  const router = Router();
  router.get('/', (_req, res) => {
    res.json({ users: listUsers() });
  });
  router.get('/:id', (req, res) => {
    res.json({ user: findUserById(req.params.id) });
  });
  return router;
}
`,
  'src/index.ts': `import { createApp } from './app.js';\nimport { startServer } from './server.js';\nawait startServer(createApp(), 4001);\n`,
};
const MANIFEST = {
  service: CLIENT_REPO,
  repository: `https://github.com/GH0ST-000/${CLIENT_REPO}`,
  dependencies: [
    {
      service: API_REPO,
      type: 'http',
      repository: `https://github.com/GH0ST-000/${API_REPO}`,
      contract: { format: 'openapi', version: '3.0.3' },
      baseUrlEnv: 'USER_API_BASE_URL',
      defaultBaseUrl: 'http://localhost:4001',
      endpoints: ['GET /health', 'GET /api/users', 'GET /api/users/{id}'],
      critical: true,
    },
  ],
};
const clientSource = (withGetUser = true) => `import { DEFAULT_TIMEOUT_MS } from './config.js';

/** Endpoints of project-x-test-api used by this client (see service-dependencies.json). */
export const USER_API_ENDPOINTS = {
  health: '/health',
  users: '/api/users',
  userById: (id: string) => \`/api/users/\${encodeURIComponent(id)}\`,
} as const;

export class UserApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: { baseUrl: string; fetch?: typeof fetch }) {
    this.baseUrl = options.baseUrl.replace(/\\/+$/, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  async getHealth(): Promise<unknown> {
    return this.getJson(USER_API_ENDPOINTS.health);
  }

  async listUsers(): Promise<unknown> {
    return this.getJson(USER_API_ENDPOINTS.users);
  }
${
  withGetUser
    ? `
  async getUser(id: string): Promise<unknown> {
    return this.getJson(USER_API_ENDPOINTS.userById(id));
  }
`
    : ''
}
  private async getJson(path: string): Promise<unknown> {
    const url = \`\${this.baseUrl}\${path}\`;
    const signal = AbortSignal.timeout(DEFAULT_TIMEOUT_MS);
    const response = await this.fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal,
    });
    return response.json();
  }
}
`;
const CONFIG_SOURCE = `export const DEFAULT_USER_API_BASE_URL = 'http://localhost:4001';
export const DEFAULT_TIMEOUT_MS = 5000;
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  return { userApiBaseUrl: env.USER_API_BASE_URL?.trim() || DEFAULT_USER_API_BASE_URL };
}
`;
const clientFiles = (over: Record<string, string | null> = {}) => {
  const files: Record<string, string | null> = {
    'package.json': JSON.stringify({ name: CLIENT_REPO }),
    'README.md': `Calls https://github.com/GH0ST-000/${API_REPO}. See also https://github.com/${OWNER}/unrelated-tool.`,
    'service-dependencies.json': JSON.stringify(MANIFEST, null, 2),
    'src/userApiClient.ts': clientSource(),
    'src/config.ts': CONFIG_SOURCE,
    ...over,
  };
  return Object.fromEntries(Object.entries(files).filter(([, v]) => v !== null)) as Record<
    string,
    string
  >;
};

// ── fake api.github.com ─────────────────────────────────────────────────────────────────
interface FakeRepo {
  files: Record<string, string>;
  metaStatus?: number;
  blobStatus?: number;
  truncated?: boolean;
}
let repos: Record<string, FakeRepo> = {};
let requestLog: string[] = [];
let delayMs = 0;
const originalFetch = global.fetch;

function shaFor(repo: string, path: string): string {
  let h = 0;
  for (const ch of `${repo}:${path}`) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h.toString(16).padStart(40, '0');
}

async function fakeGithub(input: string | URL | Request): Promise<Response> {
  const url = String(input);
  if (!url.startsWith('https://api.github.com/'))
    throw new Error(`Unexpected request in test: ${url}`);
  requestLog.push(url);
  if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  const m = url.match(/^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/?]+)(\/.*)?$/);
  if (!m) return new Response('{}', { status: 404 });
  const full = `${decodeURIComponent(m[1]!)}/${decodeURIComponent(m[2]!)}`.toLowerCase();
  const repo = repos[full];
  const rest = m[3] ?? '';
  if (!repo) return new Response('{"message":"Not Found"}', { status: 404 });
  if (rest === '') {
    return repo.metaStatus
      ? new Response('{}', { status: repo.metaStatus })
      : Response.json({ full_name: full, default_branch: 'main', private: true });
  }
  if (rest.startsWith('/git/trees/HEAD')) {
    const all = Object.entries(repo.files).map(([path, content]) => ({
      path,
      type: 'blob',
      size: Buffer.byteLength(content),
      sha: shaFor(full, path),
    }));
    const tree = rest.includes('recursive=1') ? all : all.filter((e) => !e.path.includes('/'));
    return Response.json({
      sha: 'tree',
      tree,
      truncated: Boolean(repo.truncated && rest.includes('recursive')),
    });
  }
  const blob = rest.match(/^\/git\/blobs\/([0-9a-f]+)$/);
  if (blob) {
    if (repo.blobStatus) return new Response('{}', { status: repo.blobStatus });
    const entry = Object.entries(repo.files).find(([path]) => shaFor(full, path) === blob[1]);
    if (!entry) return new Response('{}', { status: 404 });
    return Response.json({ content: Buffer.from(entry[1]).toString('base64'), encoding: 'base64' });
  }
  return new Response('{}', { status: 404 });
}

const defaultRepos = (): Record<string, FakeRepo> => ({
  [`${OWNER}/${API_REPO}`]: { files: { ...API_FILES } },
  [`${OWNER}/${CLIENT_REPO}`]: { files: clientFiles() },
});

const codeOf = (error: unknown) =>
  (error as { getResponse?: () => { code?: string } }).getResponse?.()?.code;

describe.skipIf(!URL_ENV)('Systems relationship discovery (PostgreSQL, mocked GitHub)', () => {
  let prisma: PrismaClient;
  let service: MultiRepoService;
  const tokens = new Map<string, string>();
  let run = 0;

  beforeAll(async () => {
    const url = new URL(URL_ENV!);
    if (!url.pathname.endsWith('_it') || url.port === '5432') {
      throw new Error(`Refusing to run integration tests against ${url.host}${url.pathname}`);
    }
    prisma = new PrismaClient({ datasourceUrl: URL_ENV });
    await prisma.$connect();
    const entitlements = new EntitlementService(prisma as never);
    service = new MultiRepoService(
      prisma as never,
      { getDecryptedToken: async (userId: string) => tokens.get(userId) ?? null } as never,
      {} as never,
      {} as never,
      new FeatureGate(entitlements),
      entitlements,
      new UsageService(prisma as never, entitlements),
    );
    global.fetch = fakeGithub as typeof fetch;
  });

  afterAll(async () => {
    global.fetch = originalFetch;
    await prisma?.$disconnect();
  });

  afterEach(() => {
    repos = defaultRepos();
    requestLog = [];
    delayMs = 0;
  });

  async function seed(plan: 'team' | 'pro' = 'team') {
    run += 1;
    const ws = `ws_mrd_${run}_${Date.now()}`;
    await prisma.workspace.create({ data: { id: ws, name: ws, slug: ws } });
    await prisma.workspaceSubscription.create({
      data: { workspaceId: ws, provider: 'paddle', planId: plan, status: 'active' },
    });
    const user = await member(ws);
    const system = await prisma.projectSystem.create({
      data: {
        userId: user,
        workspaceId: ws,
        createdByUserId: user,
        name: 'Test Microservices',
        primaryOwner: OWNER,
        primaryRepository: API_REPO,
        repositories: {
          create: [
            { owner: OWNER, repository: API_REPO, role: 'backend' },
            { owner: OWNER, repository: CLIENT_REPO, role: 'frontend' },
          ],
        },
      },
    });
    repos = defaultRepos();
    return { ws, user, systemId: system.id };
  }

  async function member(ws: string) {
    run += 1;
    const user = `mrd_user_${run}_${Date.now()}`;
    await prisma.user.create({
      data: { id: user, email: `${user}@it.test`, passwordHash: 'x', lastWorkspaceId: ws },
    });
    await prisma.workspaceMembership.create({
      data: { workspaceId: ws, userId: user, role: 'owner', status: 'active' },
    });
    tokens.set(user, `ghp_it_token_${run}_abcdefghijklmnopqrstuvwxyz`);
    return user;
  }

  const rows = (userId: string, systemId: string) =>
    prisma.repositoryRelationship.findMany({
      where: { userId, systemId },
      orderBy: { resourceKey: 'asc' },
    });
  const usageCount = async (ws: string) =>
    (
      await prisma.workspaceUsageCounter.findUnique({
        where: {
          workspaceId_metric_periodKey: {
            workspaceId: ws,
            metric: 'multi_repo_analysis',
            periodKey: usagePeriodKey(),
          },
        },
      })
    )?.count ?? 0;
  const httpCalls = (list: Awaited<ReturnType<typeof rows>>) =>
    list.filter((r) => r.type === 'HTTP_CALLS' && r.status === 'active');

  // ── acceptance ──────────────────────────────────────────────────────────────────────────

  it('ACCEPTANCE: discovers project-x-test-client → project-x-test-api with evidence', async () => {
    const { ws, user, systemId } = await seed();
    const result = await service.refreshSystemContext(user, systemId);

    expect(result.analyzed).toBe(2);
    expect(result.unavailable).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.scan.partial).toBe(false);
    expect(result.scan.repositories.map((r) => [r.repository.repository, r.status])).toEqual([
      [API_REPO, 'complete'],
      [CLIENT_REPO, 'complete'],
    ]);
    expect(result.relationshipsChecked).toBeGreaterThan(0);

    const all = await rows(user, systemId);
    const calls = httpCalls(all);
    expect(calls.map((r) => r.resourceKey)).toEqual([
      'GET /api/users',
      'GET /api/users/{param}',
      'GET /health',
    ]);
    for (const r of calls) {
      // Direction: consumer (client) → provider (api). Never reversed.
      expect([r.fromRepository, r.toRepository]).toEqual([CLIENT_REPO, API_REPO]);
      expect(r.confidence).toBe('high');
      expect(r.workspaceId).toBe(ws);
      expect(r.systemId).toBe(systemId);
      expect(r.resourceKind).toBe('http_operation');
    }
    const evidence = calls.find((r) => r.resourceKey === 'GET /api/users/{param}')!
      .provenanceJson as unknown as RelationshipProvenance[];
    expect(evidence.map((p) => [p.type, p.repository, p.filePath])).toEqual([
      ['http_call', CLIENT_REPO, 'src/userApiClient.ts'],
      ['openapi_reference', API_REPO, 'openapi.yaml'],
      ['http_call', API_REPO, 'src/routes/users.ts'],
      ['service_manifest', CLIENT_REPO, 'service-dependencies.json'],
    ]);
    // Call site (not the fetch inside the wrapper), wrapper + base URL in the evidence.
    expect(evidence[0]!.summary).toMatch(/^GET \/api\/users\/\{param\} via baseUrl \(line \d+\)$/);
    expect(evidence[3]!.summary).toContain('USER_API_BASE_URL');
    expect(all.some((r) => r.fromRepository === API_REPO && r.toRepository === CLIENT_REPO)).toBe(
      false,
    );
    expect(
      all.filter((r) => r.type === 'PROVIDES_API').every((r) => r.fromRepository === API_REPO),
    ).toBe(true);

    // In-system references are not suggestions; the outside one was access-checked (404) and dropped.
    expect(result.candidates).toEqual([]);
    expect(requestLog.some((u) => u.endsWith(`/repos/${OWNER}/unrelated-tool`))).toBe(true);
    expect(await usageCount(ws)).toBe(1);
  });

  it('Discover runs the same scan, is charged once, and repeated scans do not duplicate rows', async () => {
    const { ws, user, systemId } = await seed();
    await service.refreshSystemContext(user, systemId);
    const first = await rows(user, systemId);
    const discovered = await service.discoverRelationships(user, systemId);
    const second = await rows(user, systemId);
    expect(second.length).toBe(first.length);
    expect(second.map((r) => r.id).sort()).toEqual(first.map((r) => r.id).sort());
    expect(discovered.relationships.filter((r) => r.type === 'HTTP_CALLS')).toHaveLength(3);
    expect(discovered.scan?.partial).toBe(false);
    expect(await usageCount(ws)).toBe(2);
    // Reading saved relationships is free.
    await service.listRelationships(user, systemId);
    expect(await usageCount(ws)).toBe(2);
  });

  // ── false positives ─────────────────────────────────────────────────────────────────────

  it('no relationship without provider evidence (and the unresolved calls are reported)', async () => {
    const { user, systemId } = await seed();
    repos[`${OWNER}/${API_REPO}`]!.files = { 'package.json': '{"name":"project-x-test-api"}' };
    repos[`${OWNER}/${CLIENT_REPO}`]!.files = clientFiles({ 'service-dependencies.json': null });
    const result = await service.refreshSystemContext(user, systemId);
    expect(httpCalls(await rows(user, systemId))).toEqual([]);
    const client = result.scan.repositories.find((r) => r.repository.repository === CLIENT_REPO)!;
    expect(client.unresolvedHttpCalls).toBe(3);
  });

  it('a shared /health endpoint alone never creates a relationship', async () => {
    const { user, systemId } = await seed();
    repos[`${OWNER}/${CLIENT_REPO}`]!.files = clientFiles({
      'service-dependencies.json': null,
      'src/userApiClient.ts': null,
      'src/ping.ts': 'export const ping = () => fetch(`${process.env.USER_API_BASE_URL}/health`);',
    });
    await service.refreshSystemContext(user, systemId);
    expect(await rows(user, systemId)).toEqual([]);
  });

  // ── scope and authorization ─────────────────────────────────────────────────────────────

  it('disabled repositories are not scanned and never linked, even when declared', async () => {
    const { user, systemId } = await seed();
    await prisma.projectSystemRepository.updateMany({
      where: { systemId, repository: API_REPO },
      data: { enabled: false },
    });
    const result = await service.refreshSystemContext(user, systemId);
    expect(result.analyzed).toBe(1);
    expect(requestLog.some((u) => u.includes(`/${API_REPO}/git/`))).toBe(false);
    expect(httpCalls(await rows(user, systemId))).toEqual([]);
  });

  it('an inaccessible repository is reported unavailable and gets no relationship', async () => {
    const { user, systemId } = await seed();
    repos[`${OWNER}/${API_REPO}`]!.metaStatus = 404;
    const result = await service.refreshSystemContext(user, systemId);
    expect(result.unavailable.map((r) => r.repository)).toEqual([API_REPO]);
    const api = result.scan.repositories.find((r) => r.repository.repository === API_REPO)!;
    expect(api).toMatchObject({
      status: 'unavailable',
      issues: [{ code: 'repository_inaccessible', count: 1 }],
    });
    expect(httpCalls(await rows(user, systemId))).toEqual([]);
  });

  it('another workspace cannot scan the system (not found, nothing charged)', async () => {
    const { systemId } = await seed();
    const other = await seed();
    await expect(service.refreshSystemContext(other.user, systemId)).rejects.toSatisfy(
      (e) => codeOf(e) === 'SYSTEM_CONTEXT_NOT_CONFIGURED',
    );
    expect(await usageCount(other.ws)).toBe(0);
  });

  // ── failures, truncation, lifecycle ─────────────────────────────────────────────────────

  it('partial GitHub failures are reported and never retire existing findings', async () => {
    const { user, systemId } = await seed();
    await service.refreshSystemContext(user, systemId);
    const before = httpCalls(await rows(user, systemId)).length;
    repos[`${OWNER}/${CLIENT_REPO}`]!.blobStatus = 500;
    const result = await service.refreshSystemContext(user, systemId);
    const client = result.scan.repositories.find((r) => r.repository.repository === CLIENT_REPO)!;
    expect(client.status).toBe('partial');
    expect(client.issues).toEqual([
      { code: 'file_unreadable', count: Object.keys(clientFiles()).length },
    ]);
    expect(result.scan.partial).toBe(true);
    expect(httpCalls(await rows(user, systemId))).toHaveLength(before);
  });

  it('truncated trees are reported as truncated', async () => {
    const { user, systemId } = await seed();
    repos[`${OWNER}/${API_REPO}`]!.truncated = true;
    const result = await service.refreshSystemContext(user, systemId);
    expect(result.truncated).toBe(true);
    expect(result.scan.repositories[0]!.issues).toEqual([{ code: 'tree_truncated', count: 1 }]);
  });

  it('a complete re-scan supersedes findings that disappeared (kept as history)', async () => {
    const { user, systemId } = await seed();
    await service.refreshSystemContext(user, systemId);
    repos[`${OWNER}/${CLIENT_REPO}`]!.files = clientFiles({
      'src/userApiClient.ts': clientSource(false),
    });
    await service.refreshSystemContext(user, systemId);
    const all = await rows(user, systemId);
    const byKey = (key: string) =>
      all.find((r) => r.type === 'HTTP_CALLS' && r.resourceKey === key)!;
    expect(byKey('GET /api/users/{param}').status).toBe('superseded');
    expect(byKey('GET /api/users').status).toBe('active');
    // Re-appearing evidence reactivates the same row.
    repos = defaultRepos();
    await service.refreshSystemContext(user, systemId);
    expect(
      (await rows(user, systemId)).find((r) => r.id === byKey('GET /api/users/{param}').id)!.status,
    ).toBe('active');
  });

  // ── multiple members ────────────────────────────────────────────────────────────────────

  it("a second member's scan never modifies the first member's rows", async () => {
    const { ws, user, systemId } = await seed();
    await service.refreshSystemContext(user, systemId);
    const firstRows = await rows(user, systemId);
    const snapshot = firstRows.map((r) => [r.id, r.updatedAt.toISOString()]);

    const second = await member(ws);
    const result = await service.refreshSystemContext(second, systemId);
    expect(result.relationshipsChecked).toBeGreaterThan(0);
    expect(httpCalls(await rows(second, systemId))).toHaveLength(3);
    expect((await rows(user, systemId)).map((r) => [r.id, r.updatedAt.toISOString()])).toEqual(
      snapshot,
    );
    expect(await service.listRelationships(user, systemId)).toHaveLength(firstRows.length);
  });

  // ── usage enforcement ───────────────────────────────────────────────────────────────────

  it('Refresh and Discover both require the plan feature', async () => {
    const { user, systemId } = await seed('pro');
    for (const run of [
      () => service.refreshSystemContext(user, systemId),
      () => service.discoverRelationships(user, systemId),
    ]) {
      await expect(run()).rejects.toSatisfy((e) => codeOf(e) === 'FEATURE_NOT_AVAILABLE');
    }
    expect(requestLog).toEqual([]);
  });

  it('Refresh and Discover both stop at the monthly analysis limit', async () => {
    const { ws, user, systemId } = await seed();
    await prisma.workspaceUsageCounter.create({
      data: {
        workspaceId: ws,
        metric: 'multi_repo_analysis',
        periodKey: usagePeriodKey(),
        count: 100,
      },
    });
    for (const run of [
      () => service.refreshSystemContext(user, systemId),
      () => service.discoverRelationships(user, systemId),
    ]) {
      await expect(run()).rejects.toSatisfy((e) => codeOf(e) === 'USAGE_LIMIT_REACHED');
    }
    expect(requestLog).toEqual([]);
    expect(await usageCount(ws)).toBe(100);
  });

  it('concurrent scans of the same system by the same user: one runs, one is rejected, charged once', async () => {
    const { ws, user, systemId } = await seed();
    delayMs = 15;
    const settled = await Promise.allSettled([
      service.refreshSystemContext(user, systemId),
      service.discoverRelationships(user, systemId),
    ]);
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    const rejected = settled.find((s) => s.status === 'rejected') as PromiseRejectedResult;
    expect(codeOf(rejected.reason)).toBe('AI_OPERATION_IN_PROGRESS');
    expect(await usageCount(ws)).toBe(1);
  });

  it('a failed scan is refunded (no token → actionable error, no charge)', async () => {
    const { ws, user, systemId } = await seed();
    tokens.delete(user);
    await expect(service.refreshSystemContext(user, systemId)).rejects.toSatisfy(
      (e) => codeOf(e) === 'SYSTEM_REPOSITORY_NOT_ACCESSIBLE',
    );
    expect(await usageCount(ws)).toBe(0);
  });

  // ── evidence-gap regressions (real repository structure) ───────────────────────────────

  it('upgrades the earlier declaration-only result: low service row superseded, evidence rows high', async () => {
    const { ws, user, systemId } = await seed();
    // What the real scan stored before the fix: one low, manifest-only "service" relationship.
    await prisma.repositoryRelationship.create({
      data: {
        userId: user,
        workspaceId: ws,
        systemId,
        fromOwner: OWNER,
        fromRepository: CLIENT_REPO,
        toOwner: OWNER,
        toRepository: API_REPO,
        type: 'HTTP_CALLS',
        resourceKind: 'service',
        resourceKey: `${OWNER}/${API_REPO}`,
        confidence: 'low',
        status: 'active',
        provenanceJson: [
          {
            type: 'service_manifest',
            filePath: 'service-dependencies.json',
            summary:
              'Declared in service-dependencies.json (USER_API_BASE_URL) — not confirmed by provider routes or OpenAPI',
            observedAt: new Date().toISOString(),
          },
        ],
      },
    });
    await service.refreshSystemContext(user, systemId);
    const all = await rows(user, systemId);
    expect(all.find((r) => r.resourceKind === 'service')!.status).toBe('superseded');
    expect(httpCalls(all).map((r) => [r.resourceKey, r.confidence])).toEqual([
      ['GET /api/users', 'high'],
      ['GET /api/users/{param}', 'high'],
      ['GET /health', 'high'],
    ]);
    // Idempotent: a repeated scan neither duplicates rows nor revives the old one.
    await service.refreshSystemContext(user, systemId);
    expect((await rows(user, systemId)).length).toBe(all.length);
  });

  it('file budget truncation is reported and the client source is still read first', async () => {
    const { user, systemId } = await seed();
    const extra = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [
        `src/util/helper${i}.ts`,
        `export const h${i} = ${i};`,
      ]),
    );
    repos[`${OWNER}/${CLIENT_REPO}`]!.files = clientFiles(extra);
    const result = await service.refreshSystemContext(user, systemId);
    const client = result.scan.repositories.find((r) => r.repository.repository === CLIENT_REPO)!;
    expect(result.truncated).toBe(true);
    expect(client.status).toBe('partial');
    expect(client.issues.map((i) => i.code)).toContain('file_budget_reached');
    expect(client.filesScanned).toBe(24);
    expect(httpCalls(await rows(user, systemId))).toHaveLength(3);
  });

  it('ambiguous providers: the manifest endpoint list attributes the calls, but only as medium', async () => {
    const { user, systemId } = await seed();
    const COPY = 'project-x-test-api-v2';
    await prisma.projectSystemRepository.create({
      data: { systemId, owner: OWNER, repository: COPY, role: 'backend' },
    });
    repos[`${OWNER}/${COPY}`] = { files: { 'openapi.yaml': API_FILES['openapi.yaml']! } };
    await service.refreshSystemContext(user, systemId);
    const calls = httpCalls(await rows(user, systemId));
    expect(new Set(calls.map((r) => r.toRepository))).toEqual(new Set([API_REPO]));
    expect(
      calls.filter((r) => r.resourceKey !== 'GET /health').every((r) => r.confidence === 'medium'),
    ).toBe(true);
    // Without the manifest the calls stay unresolved — no guessed relationship.
    repos[`${OWNER}/${CLIENT_REPO}`]!.files = clientFiles({ 'service-dependencies.json': null });
    const second = await seed();
    await prisma.projectSystemRepository.create({
      data: { systemId: second.systemId, owner: OWNER, repository: COPY, role: 'backend' },
    });
    repos[`${OWNER}/${COPY}`] = { files: { 'openapi.yaml': API_FILES['openapi.yaml']! } };
    repos[`${OWNER}/${CLIENT_REPO}`]!.files = clientFiles({ 'service-dependencies.json': null });
    const result = await service.refreshSystemContext(second.user, second.systemId);
    expect(httpCalls(await rows(second.user, second.systemId))).toEqual([]);
    expect(
      result.scan.repositories.find((r) => r.repository.repository === CLIENT_REPO)!
        .unresolvedHttpCalls,
    ).toBe(3);
  });

  // ── Phase 1: deterministic downstream impact of a contract change ──────────────────────

  const contractYaml = (userFields: string, doc = '') => `openapi: 3.0.3
info:
  title: project-x-test-api
  version: 1.0.0
paths:
  /health:
    get:
      responses:
        '200':
          description: OK${doc}
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
components:
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
  const DISPLAY_NAME = '        displayName: { type: string }';
  const contractDiff = (base: string, head: string) => {
    const norm = (raw: string) =>
      normalizeOpenApiDocument(parseOpenApiRaw(raw).document, { type: 'page' }, raw);
    const d = diffApiContracts(norm(base), norm(head), {
      baseRef: 'main',
      headRef: 'breaking/display-name',
    });
    return [...d.breakingChanges, ...d.nonBreakingChanges, ...d.uncertainChanges];
  };
  const impactOf = (userId: string, changes: ReturnType<typeof contractDiff>, systemId?: string) =>
    service.computeContractDownstreamImpact(userId, {
      owner: OWNER,
      repository: API_REPO,
      changes,
      ...(systemId ? { systemId } : {}),
    });

  it('ACCEPTANCE (Phase 1): users[].name removed on GET /api/users → project-x-test-client potentially affected; /health not flagged', async () => {
    const { ws, user, systemId } = await seed();
    await service.refreshSystemContext(user, systemId);
    const usageBefore = await usageCount(ws);

    const changes = contractDiff(contractYaml(NAME), contractYaml(DISPLAY_NAME));
    expect(
      changes
        .filter((c) => c.impact === 'breaking')
        .map((c) => `${c.method} ${c.path} ${c.fieldPath}`),
    ).toEqual(['GET /api/users users[].name', 'GET /api/users/{id} user.name']);
    expect(
      changes
        .filter((c) => c.kind === 'added-response-field')
        .every((c) => c.impact === 'non-breaking'),
    ).toBe(true);

    const impact = await impactOf(user, changes);
    expect(impact.findings.map((f) => [f.operation, f.fieldPath, f.status])).toEqual([
      ['GET /api/users', 'users[].name', 'potentially_affected'],
      ['GET /api/users/{param}', 'user.name', 'potentially_affected'],
    ]);
    for (const finding of impact.findings) {
      expect(finding.consumers).toHaveLength(1);
      const consumer = finding.consumers[0]!;
      expect(consumer.repository).toMatchObject({ owner: OWNER, repository: CLIENT_REPO });
      expect(consumer.confidence).toBe('high');
      expect(consumer.systems).toEqual([{ id: systemId, name: 'Test Microservices' }]);
      expect(consumer.stale).toBe(false);
      expect(consumer.lastValidatedAt).toBeDefined();
      expect(
        consumer.evidence.find((e) => e.type === 'http_call' && e.repository === CLIENT_REPO)
          ?.filePath,
      ).toBe('src/userApiClient.ts');
    }
    expect(impact.findings.some((f) => f.operation === 'GET /health')).toBe(false);
    expect(impact.graph.relationshipsConsidered).toBe(3); // 3 consumer calls; PROVIDES_API rows ignored
    expect(await usageCount(ws)).toBe(usageBefore); // impact computation is free
  });

  it('documentation-only contract changes report no impact', async () => {
    const { user, systemId } = await seed();
    await service.refreshSystemContext(user, systemId);
    const changes = contractDiff(
      contractYaml(NAME),
      contractYaml(NAME, '\n          x-note: wording only'),
    );
    expect((await impactOf(user, changes)).findings).toEqual([]);
  });

  it('only authorized graph data: other workspaces and other members see no consumers', async () => {
    const { ws, user, systemId } = await seed();
    await service.refreshSystemContext(user, systemId);
    const changes = contractDiff(contractYaml(NAME), contractYaml(DISPLAY_NAME));

    const outsider = await seed(); // another workspace with the same repositories, never scanned
    const theirs = await impactOf(outsider.user, changes);
    expect(theirs.findings.every((f) => f.status === 'no_known_consumers')).toBe(true);
    expect(theirs.graph.relationshipsConsidered).toBe(0);
    expect(await impactOf(outsider.user, changes, systemId)).toMatchObject({
      findings: [{ status: 'no_known_consumers' }, { status: 'no_known_consumers' }],
    });

    const teammate = await member(ws); // same workspace, relationships are per user
    expect((await impactOf(teammate, changes)).graph.relationshipsConsidered).toBe(0);
  });

  it('disabled consumers and superseded rows are excluded', async () => {
    const { user, systemId } = await seed();
    await service.refreshSystemContext(user, systemId);
    const changes = contractDiff(contractYaml(NAME), contractYaml(DISPLAY_NAME));

    await prisma.projectSystemRepository.updateMany({
      where: { systemId, repository: CLIENT_REPO },
      data: { enabled: false },
    });
    expect((await impactOf(user, changes)).findings.every((f) => f.consumers.length === 0)).toBe(
      true,
    );
    await prisma.projectSystemRepository.updateMany({
      where: { systemId, repository: CLIENT_REPO },
      data: { enabled: true },
    });

    await prisma.repositoryRelationship.updateMany({
      where: { userId: user, systemId },
      data: { status: 'superseded' },
    });
    expect((await impactOf(user, changes)).graph.relationshipsConsidered).toBe(0);
  });

  it('the same consumer in two systems is reported once with both systems', async () => {
    const { ws, user, systemId } = await seed();
    await service.refreshSystemContext(user, systemId);
    const second = await prisma.projectSystem.create({
      data: {
        userId: user,
        workspaceId: ws,
        name: 'Users platform',
        primaryOwner: OWNER,
        primaryRepository: API_REPO,
        repositories: {
          create: [
            { owner: OWNER, repository: API_REPO },
            { owner: OWNER, repository: CLIENT_REPO },
          ],
        },
      },
    });
    await service.refreshSystemContext(user, second.id);
    const changes = contractDiff(contractYaml(NAME), contractYaml(DISPLAY_NAME));
    const all = await impactOf(user, changes);
    expect(all.findings[0]!.consumers).toHaveLength(1);
    expect(all.findings[0]!.consumers[0]!.systems.map((s) => s.id).sort()).toEqual(
      [systemId, second.id].sort(),
    );
    const one = await impactOf(user, changes, second.id);
    expect(one.findings[0]!.consumers[0]!.systems.map((s) => s.id)).toEqual([second.id]);
  });
});
