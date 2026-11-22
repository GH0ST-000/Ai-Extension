/**
 * Project Memory with the workspace GitHub App, members with and WITHOUT a personal GitHub
 * token (PostgreSQL + real HTTP).
 *
 * Trust model under test (H1): the workspace's active GitHub App installation is used for
 * repository access only after the acting user's OWN GitHub access was verified with their
 * personal token. A member without a token has no verified GitHub identity and is refused,
 * whatever the installation covers. Workspaces without an installation use the personal token
 * directly; without either there is no access.
 *
 * Real: PostgreSQL, ProjectMemoryController + ValidationPipe (main.ts options), RequestContext
 * middleware (X-Workspace-Id), exception filter, ProjectMemoryService, WorkspaceAuthorization,
 * FeatureGate/Entitlements, GithubAccessService, GithubAppInstallationService lookup.
 * Stubbed: JWT (x-test-user), App token minting, PAT storage, GitHub's REST API, Redis.
 */
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { JwtAuthGuard } from '../../src/auth/jwt-auth.guard';
import { encryptSecret } from '../../src/common/crypto/secret-box';
import { EntitlementService } from '../../src/entitlements/entitlements.service';
import { FeatureGate } from '../../src/entitlements/feature-gate';
import { GithubAccessService } from '../../src/github-app/github-access.service';
import { GithubAppInstallationService } from '../../src/github-app/github-app-installation.service';
import { ObservabilityExceptionFilter } from '../../src/observability/observability-exception.filter';
import { RequestContextMiddleware } from '../../src/observability/request-context.middleware';
import { RequestContextService } from '../../src/observability/request-context.service';
import { ProjectMemoryController } from '../../src/project-memory/project-memory.controller';
import { ProjectMemoryService } from '../../src/project-memory/project-memory.service';
import { WorkspaceAuthorizationService } from '../../src/workspaces/workspace-authorization.service';

const URL_ENV = process.env.MEMORY_IT_DATABASE_URL;
const ENCRYPTION_KEY = 'it-encryption-key-0123456789abcdef0123';
const OWNER = 'acme';
const REPO = 'payments';
const BASE = `/api/projects/${OWNER}/${REPO}/memory`;

/** Repositories each installation can see (what GitHub would answer). */
const INSTALLATION_REPOS: Record<string, string[]> = {};
/** Personal tokens by user id (absent = no GitHub account / token). */
const PATS: Record<string, string> = {};
let appEnabled = true;

describe.skipIf(!URL_ENV)('Project Memory for members without a GitHub token', () => {
  let prisma: PrismaClient;
  let app: INestApplication;
  let baseUrl: string;
  let memory: ProjectMemoryService;
  const realFetch = globalThis.fetch;
  let run = 0;

  beforeAll(async () => {
    const url = new URL(URL_ENV!);
    if (!url.pathname.endsWith('_it') || url.port === '5432') {
      throw new Error(`Refusing to run integration tests against ${url.host}${url.pathname}`);
    }
    prisma = new PrismaClient({ datasourceUrl: URL_ENV });
    await prisma.$connect();

    const requestContext = new RequestContextService();
    const appTokens = {
      isAppAuthEnabled: () => appEnabled,
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
      } as never,
    );
    const redisStore = new Map<string, string>();
    memory = new ProjectMemoryService(
      prisma as never,
      {
        get: vi.fn(async (k: string) => redisStore.get(k) ?? null),
        set: vi.fn(async (k: string, v: string) => redisStore.set(k, v)),
        del: vi.fn(async (k: string) => redisStore.delete(k)),
      } as never,
      githubAccess,
      { fetchRepositoryFileAtRef: vi.fn(async () => null) } as never,
      new FeatureGate(new EntitlementService(prisma as never)),
      new WorkspaceAuthorizationService(prisma as never),
    );

    const moduleRef = await Test.createTestingModule({
      controllers: [ProjectMemoryController],
      providers: [{ provide: ProjectMemoryService, useValue: memory }],
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
    appEnabled = true;
    // GitHub's repository endpoint: an installation sees only its repositories; a personal
    // token (ghp_*) sees everything; anything else is unauthorized.
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const target = String(input);
      if (!target.startsWith('https://api.github.com/')) return realFetch(input, init);
      const auth = new Headers(init?.headers).get('authorization') ?? '';
      const token = auth.replace(/^Bearer\s+/i, '');
      const match = /\/repos\/([^/]+)\/([^/?]+)/.exec(target);
      const full = match ? `${decodeURIComponent(match[1]!)}/${decodeURIComponent(match[2]!)}` : '';
      if (token.startsWith('ghs_inst_')) {
        const repos = INSTALLATION_REPOS[token.slice('ghs_inst_'.length)] ?? [];
        return repos.includes(full)
          ? Response.json({ id: 1, full_name: full })
          : Response.json({ message: 'Not Found' }, { status: 404 });
      }
      // A personal token as GitHub answers it for an authenticated user: with permissions.
      if (token.startsWith('ghp_')) {
        return Response.json({ id: 1, full_name: full, permissions: { pull: true, push: true } });
      }
      return Response.json({ message: 'Bad credentials' }, { status: 401 });
    }) as typeof fetch;
  });

  // ── helpers ──────────────────────────────────────────────────────────────

  type Role = 'owner' | 'admin' | 'member';

  /**
   * A workspace with members. `installation` = repositories its GitHub App can see (omit for
   * a PAT-only workspace). Users named in `withPat` get a personal token.
   */
  async function seed(opts: {
    roles: Record<string, Role>;
    installation?: string[];
    installationStatus?: string;
    plan?: { planId: string; status: string };
    withPat?: string[];
  }) {
    run += 1;
    const tag = `${run}_${Date.now()}`;
    const ws = `ws_tl_${tag}`;
    await prisma.workspace.create({ data: { id: ws, name: ws, slug: ws } });
    await prisma.workspaceSubscription.create({
      data: {
        workspaceId: ws,
        provider: 'paddle',
        ...(opts.plan ?? { planId: 'team', status: 'active' }),
      },
    });
    if (opts.installation) {
      const installationId = `9${run}${Date.now() % 100000}`;
      INSTALLATION_REPOS[installationId] = opts.installation;
      // A link made through the verified flow (ownership proof stored encrypted).
      await prisma.gitHubAppInstallation.create({
        data: {
          workspaceId: ws,
          installationId,
          accountLogin: 'acme',
          accountType: 'Organization',
          repositorySelection: 'selected',
          status: opts.installationStatus ?? 'active',
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
      const id = `tl_${name}_${tag}`;
      users[name] = id;
      await prisma.user.create({
        data: { id, email: `${id}@it.test`, passwordHash: 'x', lastWorkspaceId: ws },
      });
      await prisma.workspaceMembership.create({
        data: { workspaceId: ws, userId: id, role, status: 'active' },
      });
      if (opts.withPat?.includes(name)) PATS[id] = `ghp_${name}_${tag}`;
    }
    return { ws, users };
  }

  async function call(
    user: string,
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await realFetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-user': user, ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  }

  const pref = (user: string, text = 'Prefer short review summaries.', base = BASE, h = {}) =>
    call(user, 'POST', `${base}/rules`, { category: 'USER_PREFERENCE', text }, h);
  const shared = (user: string, text = 'Webhook handlers must be idempotent.', h = {}) =>
    call(user, 'POST', `${BASE}/rules`, { category: 'PROJECT_CONSTRAINT', key: 'pay.wh', text }, h);
  const statusOf = async (id: string) =>
    (await prisma.projectMemory.findUnique({ where: { id } }))!.status;
  const rowsBy = (userId: string) => prisma.projectMemory.findMany({ where: { userId } });
  const TRUSTED = [`${OWNER}/${REPO}`];

  // ── 1. own preference lifecycle, no token, trusted repository ────────────

  it('[0] H1: a member WITHOUT a token is refused, even though the installation covers the repo', async () => {
    const { users } = await seed({ roles: { owner: 'owner', m: 'member' }, installation: TRUSTED });
    const refused = await pref(users.m!);
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.body)).toContain('Connect your own GitHub token');
    expect(await rowsBy(users.m!)).toEqual([]);
  });

  it('[1] member with a token (verified access) creates, edits, disputes, archives and reactivates own preference', async () => {
    const { ws, users } = await seed({
      roles: { owner: 'owner', m: 'member' },
      installation: TRUSTED,
      withPat: ['m'],
    });
    const m = users.m!;
    const created = await pref(m);
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    expect(await prisma.projectMemory.findUnique({ where: { id } })).toMatchObject({
      userId: m,
      createdByUserId: m,
      workspaceId: ws,
      visibility: 'user',
      owner: OWNER,
      repository: REPO,
    });

    const edited = await call(m, 'PATCH', `${BASE}/${id}`, {
      text: 'Prefer bullet-point summaries.',
      expectedUpdatedAt: created.body.updatedAt,
    });
    expect(edited.status).toBe(200);
    expect((await call(m, 'PATCH', `${BASE}/${id}`, { status: 'disputed' })).status).toBe(200);
    expect((await call(m, 'PATCH', `${BASE}/${id}`, { status: 'active' })).status).toBe(200);
    expect((await call(m, 'DELETE', `${BASE}/${id}`)).status).toBe(200);
    expect(await statusOf(id)).toBe('archived');
    expect((await call(m, 'PATCH', `${BASE}/${id}`, { status: 'active' })).status).toBe(200);
    expect(await statusOf(id)).toBe('active');
    const list = await call(m, 'GET', BASE);
    expect((list.body.items as { id: string }[]).map((i) => i.id)).toEqual([id]);
  });

  // ── 2. another user's preference ─────────────────────────────────────────

  it("[2] member cannot see or modify another user's preference", async () => {
    const { users } = await seed({
      roles: { owner: 'owner', m1: 'member', m2: 'member' },
      installation: TRUSTED,
      withPat: ['owner', 'm1', 'm2'],
    });
    const theirs = (await pref(users.m1!, 'Keep comments terse.')).body.id as string;
    for (const req of [
      () => call(users.m2!, 'PATCH', `${BASE}/${theirs}`, { text: 'hijack' }),
      () => call(users.m2!, 'PATCH', `${BASE}/${theirs}`, { status: 'archived' }),
      () => call(users.m2!, 'PATCH', `${BASE}/${theirs}`, { status: 'disputed' }),
      () => call(users.m2!, 'DELETE', `${BASE}/${theirs}`),
      // Owners cannot manage someone's personal preference either.
      () => call(users.owner!, 'PATCH', `${BASE}/${theirs}`, { text: 'owner edit' }),
    ]) {
      const res = await req();
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('PROJECT_MEMORY_ITEM_NOT_FOUND');
    }
    expect(await statusOf(theirs)).toBe('active');
  });

  // ── 3. shared rules ──────────────────────────────────────────────────────

  it('[3] member cannot create or modify shared rules, whatever the payload', async () => {
    const { users } = await seed({
      roles: { owner: 'owner', m: 'member' },
      installation: TRUSTED,
      withPat: ['owner', 'm'],
    });
    const m = users.m!;
    const rule = (await shared(users.owner!)).body.id as string;
    for (const res of [
      await shared(m),
      await call(m, 'PATCH', `${BASE}/${rule}`, { text: 'member edit' }),
      await call(m, 'PATCH', `${BASE}/${rule}`, { status: 'disputed' }),
      await call(m, 'DELETE', `${BASE}/${rule}`),
      await call(m, 'POST', `${BASE}/clear`, { confirm: true }),
      await call(m, 'POST', `${BASE}/learn`),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('WORKSPACE_ACCESS_DENIED');
    }
    // Payload tampering: visibility / ownership fields are rejected, never honoured.
    for (const extra of [
      { visibility: 'workspace' },
      { userId: users.owner },
      { workspaceId: 'x' },
    ]) {
      const res = await call(m, 'POST', `${BASE}/rules`, {
        category: 'USER_PREFERENCE',
        text: 'Sneaky.',
        ...extra,
      });
      expect(res.status).toBe(400);
    }
    expect(await statusOf(rule)).toBe('active');
    expect(await rowsBy(m)).toEqual([]);
  });

  // ── 4. untrusted repositories ────────────────────────────────────────────

  it('[4] member cannot target a repository the workspace installation does not cover', async () => {
    const { users } = await seed({ roles: { owner: 'owner', m: 'member' }, installation: TRUSTED });
    for (const base of [
      `/api/projects/${OWNER}/secret-repo/memory`,
      '/api/projects/someone-else/payments/memory',
    ]) {
      const res = await pref(users.m!, 'Prefer short summaries.', base);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PROJECT_MEMORY_ACCESS_DENIED');
    }
    expect(await rowsBy(users.m!)).toEqual([]);
  });

  it('[4] no workspace-level trust (no installation, suspended installation or App disabled) → refused', async () => {
    const patOnly = await seed({ roles: { owner: 'owner', m: 'member' }, withPat: ['owner'] });
    const suspended = await seed({
      roles: { owner: 'owner', m: 'member' },
      installation: TRUSTED,
      installationStatus: 'suspended',
    });
    for (const m of [patOnly.users.m!, suspended.users.m!]) {
      const res = await pref(m);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PROJECT_MEMORY_ACCESS_DENIED');
      expect(String(res.body.message)).toMatch(/GitHub App/);
    }
    // Existing memory rows are not treated as trust: an owner rule exists, member still refused.
    expect((await shared(patOnly.users.owner!)).status).toBe(201);
    expect((await pref(patOnly.users.m!)).status).toBe(403);

    const installed = await seed({ roles: { m: 'member' }, installation: TRUSTED });
    appEnabled = false;
    expect((await pref(installed.users.m!)).status).toBe(403);
  });

  // ── 5. cross-workspace isolation ─────────────────────────────────────────

  it("[5] another workspace's installation and spoofed headers grant nothing", async () => {
    const a = await seed({ roles: { owner: 'owner' }, installation: TRUSTED });
    const b = await seed({ roles: { m: 'member' }, installation: ['other-org/tool'] });
    const aPref = (
      await call(a.users.owner!, 'POST', `${BASE}/rules`, {
        category: 'USER_PREFERENCE',
        text: 'Owner A preference.',
      })
    ).body.id as string;

    // B's member, acting in B: B's installation does not cover acme/payments.
    const own = await pref(b.users.m!);
    expect(own.status).toBe(403);
    expect(own.body.code).toBe('PROJECT_MEMORY_ACCESS_DENIED');
    // Spoofing A as the workspace: rejected before anything else.
    const spoof = await pref(b.users.m!, 'x', BASE, { 'x-workspace-id': a.ws });
    expect(spoof.status).toBe(403);
    expect(spoof.body.code).toBe('WORKSPACE_CONTEXT_UNAVAILABLE');
    const touch = await call(
      b.users.m!,
      'PATCH',
      `${BASE}/${aPref}`,
      { text: 'x' },
      {
        'x-workspace-id': a.ws,
      },
    );
    expect(touch.status).toBe(403);
    expect(await rowsBy(b.users.m!)).toEqual([]);
  });

  // ── 6. plan restrictions ─────────────────────────────────────────────────

  it('[6] free plan: feature gate refuses, even with a trusting installation', async () => {
    const { users } = await seed({
      roles: { m: 'member' },
      installation: TRUSTED,
      plan: { planId: 'free', status: 'none' },
    });
    const res = await pref(users.m!);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FEATURE_NOT_AVAILABLE');
  });

  // ── 7. GitHub-dependent actions ──────────────────────────────────────────

  it('[7] GitHub-dependent actions still require GitHub access', async () => {
    // PAT-only workspace, admin without a token: Learn and shared writes refused.
    const { ws, users } = await seed({
      roles: { owner: 'owner', admin: 'admin', m: 'member' },
      withPat: ['owner'],
    });
    for (const res of [
      await call(users.admin!, 'POST', `${BASE}/learn`),
      await shared(users.admin!),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PROJECT_MEMORY_ACCESS_DENIED');
    }
    // AI review context for a tokenless member without workspace trust: not applied.
    await shared(users.owner!);
    const ctx = await memory.resolvePromptContext({
      userId: users.m!,
      workspaceId: ws,
      owner: OWNER,
      repository: REPO,
      capability: 'PR_REVIEW',
    } as never);
    expect(ctx).toMatchObject({ status: 'skipped', reason: 'github_not_connected' });
  });

  // ── 8. owners and admins ─────────────────────────────────────────────────

  it('[8] owners and admins: unchanged with a token; via the installation only with their own token', async () => {
    const patOnly = await seed({ roles: { owner: 'owner' }, withPat: ['owner'] });
    const id = (await shared(patOnly.users.owner!)).body.id as string;
    expect(
      (await call(patOnly.users.owner!, 'PATCH', `${BASE}/${id}`, { text: 'Edited.' })).status,
    ).toBe(200);
    expect((await call(patOnly.users.owner!, 'DELETE', `${BASE}/${id}`)).status).toBe(200);

    const tokenless = await seed({ roles: { admin: 'admin' }, installation: TRUSTED });
    expect((await shared(tokenless.users.admin!)).status).toBe(403); // H1: no verified identity

    const installed = await seed({
      roles: { admin: 'admin' },
      installation: TRUSTED,
      withPat: ['admin'],
    });
    const rule = await shared(installed.users.admin!);
    expect(rule.status).toBe(201);
    expect(
      (
        await call(installed.users.admin!, 'PATCH', `${BASE}/${rule.body.id}`, {
          status: 'disputed',
        })
      ).status,
    ).toBe(200);
  });
});
