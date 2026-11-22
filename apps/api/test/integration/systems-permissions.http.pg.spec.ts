/**
 * M4 — Systems permissions and workspace isolation, against real PostgreSQL over real HTTP.
 *
 * Real: PostgreSQL, MultiRepoController + ValidationPipe (main.ts options),
 * ResolvedWorkspacePermissionGuard, WorkspaceAuthorizationService, MultiRepoService,
 * GithubAccessService (H1 personal-permission check), ContractImpactService, entitlements,
 * feature gate, usage metering, RequestContext middleware (X-Workspace-Id) and the exception
 * filter.
 * Stubbed: JWT (`x-test-user`), GitHub's REST API (an in-memory simulation keyed by token),
 * installation-token minting, PAT storage, the repository file scanner (returns no files —
 * scanning accuracy is covered by multi-repo-discovery.pg.spec.ts), the audit sink (captured).
 * Nothing external is contacted; no AI is called.
 */
import { Test } from '@nestjs/testing';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { JwtAuthGuard } from '../../src/auth/jwt-auth.guard';
import { ContractImpactService } from '../../src/contract-impact/contract-impact.service';
import { EntitlementService } from '../../src/entitlements/entitlements.service';
import { FeatureGate } from '../../src/entitlements/feature-gate';
import { GithubAccessService } from '../../src/github-app/github-access.service';
import { MultiRepoController } from '../../src/multi-repo/multi-repo.controller';
import { MultiRepoService } from '../../src/multi-repo/multi-repo.service';
import { ObservabilityExceptionFilter } from '../../src/observability/observability-exception.filter';
import { RequestContextMiddleware } from '../../src/observability/request-context.middleware';
import { RequestContextService } from '../../src/observability/request-context.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { RedisService } from '../../src/redis/redis.service';
import { RateLimitGuard } from '../../src/common/security/rate-limit.guard';
import { UsageService } from '../../src/usage/usage.service';
import { ResolvedWorkspacePermissionGuard } from '../../src/workspaces/resolved-workspace-permission.guard';
import { WorkspaceAuthorizationService } from '../../src/workspaces/workspace-authorization.service';

const URL_ENV = process.env.MEMORY_IT_DATABASE_URL;
type Role = 'owner' | 'admin' | 'member';
type Res = { status: number; body: Record<string, unknown> & { code?: string } };

/** What each personal token (by user id) can read on GitHub: "owner/repo" set. */
const USER_REPOS: Record<string, Set<string>> = {};
/** Personal tokens by user id (absent = no personal token connected). */
const PATS: Record<string, string> = {};
/** Repositories each App installation covers. */
const INSTALLATION_REPOS: Record<string, Set<string>> = {};

describe.skipIf(!URL_ENV)('Systems permissions and workspace isolation (M4)', () => {
  let prisma: PrismaClient;
  let app: INestApplication;
  let baseUrl: string;
  let service: MultiRepoService;
  let contractImpact: ContractImpactService;
  const audit = { record: vi.fn() };
  const realFetch = globalThis.fetch;
  const rateCounters = new Map<string, number>();
  const githubCalls: string[] = [];
  let run = 0;

  beforeAll(async () => {
    const url = new URL(URL_ENV!);
    if (!url.pathname.endsWith('_it') || url.port === '5432') {
      throw new Error(`Refusing to run integration tests against ${url.host}${url.pathname}`);
    }
    prisma = new PrismaClient({ datasourceUrl: URL_ENV });
    await prisma.$connect();

    const requestContext = new RequestContextService();
    const authorization = new WorkspaceAuthorizationService(prisma as never);
    const entitlements = new EntitlementService(prisma as never);
    const githubAccess = new GithubAccessService(
      prisma as never,
      requestContext,
      {
        isAppAuthEnabled: () => true,
        mintInstallationAccessToken: async (id: string) => `ghs_inst_${id}`,
      } as never,
      {
        getActiveInstallationId: async (workspaceId: string) =>
          (
            await prisma.gitHubAppInstallation.findFirst({
              where: { workspaceId, status: 'active' },
            })
          )?.installationId ?? null,
      } as never,
      {
        getDecryptedToken: async (userId: string) => PATS[userId] ?? null,
        getConnectionVersion: async (userId: string) => (PATS[userId] ? `v:${userId}` : null),
      } as never,
    );
    service = new MultiRepoService(
      prisma as never,
      githubAccess,
      { fetchRepositoryFileAtRef: async () => null } as never,
      { getProfile: async () => Promise.reject(new Error('no memory')) } as never,
      new FeatureGate(entitlements),
      entitlements,
      new UsageService(prisma as never, entitlements),
      authorization,
      audit as never,
    );
    service.scannerFactory = () =>
      ({
        scan: async () => ({ status: 'complete', files: [], issues: new Map() }),
        halted: null,
        requests: 0,
      }) as never;
    contractImpact = new ContractImpactService(prisma as never, githubAccess, authorization);

    const moduleRef = await Test.createTestingModule({
      controllers: [MultiRepoController],
      providers: [
        { provide: MultiRepoService, useValue: service },
        { provide: PrismaService, useValue: prisma },
        { provide: WorkspaceAuthorizationService, useValue: authorization },
        ResolvedWorkspacePermissionGuard,
        // N-9: the real rate-limit guard with an in-memory Redis double.
        {
          provide: RedisService,
          useValue: {
            status: 'ready',
            incr: async (key: string) => {
              const next = (rateCounters.get(key) ?? 0) + 1;
              rateCounters.set(key, next);
              return next;
            },
            expire: async () => 1,
          },
        },
        RateLimitGuard,
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
    const ctxMiddleware = new RequestContextMiddleware(
      requestContext,
      { shouldSample: () => false } as never,
      { get: () => undefined } as never,
    );
    app.use((req: Request, res: Response, next: NextFunction) => ctxMiddleware.use(req, res, next));
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

    // Simulated GitHub: a personal token sees what its user can read (with permissions); an
    // installation token sees the repositories of its installation.
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const target = String(input);
      if (!target.startsWith('https://api.github.com/')) return realFetch(input, init);
      githubCalls.push(target);
      const token = (new Headers(init?.headers).get('authorization') ?? '').replace(
        /^Bearer\s+/i,
        '',
      );
      const match = /\/repos\/([^/]+)\/([^/?]+)$/.exec(target);
      if (!match) return Response.json({ message: 'Not Found' }, { status: 404 });
      const full =
        `${decodeURIComponent(match[1]!)}/${decodeURIComponent(match[2]!)}`.toLowerCase();
      if (token.startsWith('ghs_inst_')) {
        const repos = INSTALLATION_REPOS[token.slice('ghs_inst_'.length)];
        return repos?.has(full)
          ? Response.json({ full_name: full, default_branch: 'main' })
          : Response.json({ message: 'Not Found' }, { status: 404 });
      }
      const user = Object.entries(PATS).find(([, t]) => t === token)?.[0];
      if (user && USER_REPOS[user]?.has(full)) {
        return Response.json({
          full_name: full,
          default_branch: 'main',
          permissions: { pull: true, push: false },
        });
      }
      return Response.json({ message: 'Not Found' }, { status: 404 });
    }) as typeof fetch;
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await app?.close();
    await prisma?.$disconnect();
  });

  beforeEach(() => {
    audit.record.mockClear();
    githubCalls.length = 0;
    rateCounters.clear();
  });

  // ── helpers ──────────────────────────────────────────────────────────────

  async function call(
    user: string,
    ws: string | null,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Res> {
    const res = await fetch(`${baseUrl}/api${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-test-user': user,
        ...(ws ? { 'x-workspace-id': ws } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : {} };
  }

  /**
   * A Team workspace. Every member gets a personal token able to read acme/api and acme/web,
   * unless listed in `tokenless`. `installation`: an active App installation covering them.
   */
  async function seed(
    roles: Record<string, Role>,
    opts: { installation?: boolean; tokenless?: string[] } = {},
  ) {
    run += 1;
    const tag = `${run}_${Date.now()}`;
    const ws = `ws_sys_${tag}`;
    await prisma.workspace.create({ data: { id: ws, name: ws, slug: ws } });
    await prisma.workspaceSubscription.create({
      data: { workspaceId: ws, provider: 'paddle', planId: 'team', status: 'active' },
    });
    if (opts.installation) {
      const installationId = `9${run}${Date.now() % 100000}`;
      INSTALLATION_REPOS[installationId] = new Set(['acme/api', 'acme/web', 'acme/secret']);
      await prisma.gitHubAppInstallation.create({
        data: {
          workspaceId: ws,
          installationId,
          accountLogin: 'acme',
          accountType: 'Organization',
          status: 'active',
        },
      });
    }
    const users: Record<string, string> = {};
    const memberships: Record<string, string> = {};
    for (const [name, role] of Object.entries(roles)) {
      const id = `sys_${name}_${tag}`;
      users[name] = id;
      await prisma.user.create({
        data: { id, email: `${id}@it.test`, passwordHash: 'x', lastWorkspaceId: ws },
      });
      memberships[name] = (
        await prisma.workspaceMembership.create({
          data: { workspaceId: ws, userId: id, role, status: 'active', joinedAt: new Date() },
        })
      ).id;
      if (!opts.tokenless?.includes(name)) {
        PATS[id] = `ghp_${id}`;
        USER_REPOS[id] = new Set(['acme/api', 'acme/web']);
      }
    }
    return { ws, users, memberships };
  }

  async function systemIn(ws: string, ownerId: string) {
    const created = await call(ownerId, ws, 'POST', '/systems', {
      name: `Payments ${run}`,
      primaryOwner: 'acme',
      primaryRepository: 'api',
      repositories: [{ owner: 'acme', repository: 'web', role: 'frontend' }],
    });
    expect(created.status).toBe(201);
    return created.body.id as string;
  }

  /** A stored HTTP_CALLS finding web → api for `userId` (what a discovery would persist). */
  const relationship = (userId: string, ws: string, systemId: string) =>
    prisma.repositoryRelationship.create({
      data: {
        userId,
        workspaceId: ws,
        systemId,
        fromOwner: 'acme',
        fromRepository: 'web',
        toOwner: 'acme',
        toRepository: 'api',
        type: 'HTTP_CALLS',
        resourceKind: 'http_operation',
        resourceKey: 'GET /api/users',
        confidence: 'high',
        status: 'active',
        provenanceJson: [],
      },
    });

  /** Denied without data: 403, or 404 for the caller's own non-existent fallback workspace id. */
  const expectDenied = (res: Res) => {
    expect([403, 404]).toContain(res.status);
    expect([
      'WORKSPACE_CONTEXT_UNAVAILABLE',
      'WORKSPACE_INACTIVE',
      'WORKSPACE_NOT_FOUND',
    ]).toContain(res.body.code);
    expect(Array.isArray(res.body)).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain('Payments');
  };

  const audited = (type: string) =>
    audit.record.mock.calls.map((c) => c[0] as { type: string }).filter((e) => e.type === type);

  // ── RBAC ─────────────────────────────────────────────────────────────────

  describe('RBAC (existing matrix: Owner/Admin manage, every role reads)', () => {
    it('Owner and Admin can create, update, link/unlink repositories and delete', async () => {
      for (const role of ['owner', 'admin'] as const) {
        const { ws, users } = await seed({ actor: role });
        const actor = users.actor!;
        const id = await systemIn(ws, actor);
        expect((await call(actor, ws, 'PATCH', `/systems/${id}`, { name: 'Renamed' })).status).toBe(
          200,
        );
        USER_REPOS[actor]!.add('acme/docs');
        expect(
          (
            await call(actor, ws, 'POST', `/systems/${id}/repositories`, {
              owner: 'acme',
              repository: 'docs',
            })
          ).status,
        ).toBe(201);
        expect(
          (
            await call(actor, ws, 'PATCH', `/systems/${id}/repositories/acme/docs`, {
              enabled: false,
            })
          ).status,
        ).toBe(200);
        expect(
          (await call(actor, ws, 'DELETE', `/systems/${id}/repositories/acme/docs`)).status,
        ).toBe(200);
        expect((await call(actor, ws, 'DELETE', `/systems/${id}`)).status).toBe(200);
        expect(await prisma.projectSystem.findUnique({ where: { id } })).toBeNull();
      }
      for (const type of [
        'systems.system.created',
        'systems.system.updated',
        'systems.repository.added',
        'systems.repository.updated',
        'systems.repository.removed',
        'systems.system.deleted',
      ]) {
        expect(audited(type)).toHaveLength(2);
      }
    });

    it('Members read everything but every management call is refused before it runs', async () => {
      const { ws, users } = await seed({ owner: 'owner', member: 'member' });
      const id = await systemIn(ws, users.owner!);
      const m = users.member!;
      // Reads (systems:read).
      expect((await call(m, ws, 'GET', '/systems')).status).toBe(200);
      expect((await call(m, ws, 'GET', `/systems/${id}`)).status).toBe(200);
      expect((await call(m, ws, 'GET', `/systems/${id}/relationships`)).status).toBe(200);
      expect((await call(m, ws, 'GET', `/systems/${id}/context`)).status).toBe(200);
      // Mutations (systems:manage).
      const before = await prisma.projectSystem.findUniqueOrThrow({
        where: { id },
        include: { repositories: true },
      });
      USER_REPOS[m]!.add('acme/docs');
      const attempts = [
        call(m, ws, 'POST', '/systems', {
          name: 'Mine',
          primaryOwner: 'acme',
          primaryRepository: 'api',
        }),
        call(m, ws, 'PATCH', `/systems/${id}`, { name: 'Hijacked' }),
        call(m, ws, 'DELETE', `/systems/${id}`),
        call(m, ws, 'POST', `/systems/${id}/repositories`, { owner: 'acme', repository: 'docs' }),
        call(m, ws, 'PATCH', `/systems/${id}/repositories/acme/web`, { enabled: false }),
        call(m, ws, 'DELETE', `/systems/${id}/repositories/acme/web`),
      ];
      githubCalls.length = 0;
      for (const res of await Promise.all(attempts)) {
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('WORKSPACE_ACCESS_DENIED');
      }
      expect(githubCalls).toEqual([]); // refused before any GitHub call
      const after = await prisma.projectSystem.findUniqueOrThrow({
        where: { id },
        include: { repositories: true },
      });
      expect(after.name).toBe(before.name);
      expect(after.repositories.map((r) => [r.repository, r.enabled]).sort()).toEqual(
        before.repositories.map((r) => [r.repository, r.enabled]).sort(),
      );
      expect(await prisma.projectSystem.count({ where: { workspaceId: ws } })).toBe(1);
    });

    it('Members can run Discover/Refresh (systems:read — only their own findings are stored)', async () => {
      const { ws, users } = await seed({ owner: 'owner', member: 'member' });
      const id = await systemIn(ws, users.owner!);
      const discover = await call(
        users.member!,
        ws,
        'POST',
        `/systems/${id}/relationships/discover`,
      );
      expect(discover.status).toBe(201);
      expect(discover.body.systemId).toBe(id);
      expect((await call(users.member!, ws, 'POST', `/systems/${id}/refresh`)).status).toBe(201);
    });

    it('a user who is not a member gets nothing, whichever workspace id is sent', async () => {
      const { ws, users } = await seed({ owner: 'owner' });
      const id = await systemIn(ws, users.owner!);
      const outsider = (await seed({ owner: 'owner' })).users.owner!;
      for (const [method, path] of [
        ['GET', '/systems'],
        ['GET', `/systems/${id}`],
        ['GET', `/systems/${id}/relationships`],
        ['POST', `/systems/${id}/relationships/discover`],
        ['DELETE', `/systems/${id}`],
      ] as const) {
        const res = await call(outsider, ws, method, path);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('WORKSPACE_CONTEXT_UNAVAILABLE');
        expect(JSON.stringify(res.body)).not.toContain('Payments');
      }
    });

    it('a removed member is denied on the next request', async () => {
      const { ws, users, memberships } = await seed({ owner: 'owner', member: 'member' });
      const id = await systemIn(ws, users.owner!);
      expect((await call(users.member!, ws, 'GET', `/systems/${id}`)).status).toBe(200);
      await prisma.workspaceMembership.update({
        where: { id: memberships.member },
        data: { status: 'removed' },
      });
      expect((await call(users.member!, ws, 'GET', `/systems/${id}`)).status).toBe(403);
      expect((await call(users.member!, ws, 'GET', '/systems')).status).toBe(403);
      // Without a header the fallback cannot reach the old workspace either.
      // (it resolves to the user's own, non-existent personal workspace id → denied).
      const fallback = await call(users.member!, null, 'GET', '/systems');
      expectDenied(fallback);
    });

    it.each(['deletion_pending', 'deleted'])(
      'a %s workspace is denied even to its owner',
      async (status) => {
        const { ws, users } = await seed({ owner: 'owner' });
        const id = await systemIn(ws, users.owner!);
        await prisma.workspace.update({ where: { id: ws }, data: { status } });
        for (const [method, path] of [
          ['GET', '/systems'],
          ['GET', `/systems/${id}`],
          ['DELETE', `/systems/${id}`],
        ] as const) {
          expect((await call(users.owner!, ws, method, path)).status).toBe(403);
          // The header-less fallback (lastWorkspaceId, personal workspace) is denied as well.
          expectDenied(await call(users.owner!, null, method, path));
        }
        expect(await prisma.projectSystem.findUnique({ where: { id } })).not.toBeNull();
      },
    );
  });

  // ── isolation ────────────────────────────────────────────────────────────

  describe('workspace isolation', () => {
    it('a person in both workspaces cannot read or change A’s system through B', async () => {
      const a = await seed({ owner: 'owner' });
      const b = await seed({ owner: 'owner' });
      const both = a.users.owner!;
      await prisma.workspaceMembership.create({
        data: { workspaceId: b.ws, userId: both, role: 'owner', status: 'active' },
      });
      const id = await systemIn(a.ws, both);
      await relationship(both, a.ws, id);

      const listInB = await call(both, b.ws, 'GET', '/systems');
      expect(listInB.status).toBe(200);
      expect(listInB.body).toEqual([]);
      for (const [method, path, body] of [
        ['GET', `/systems/${id}`],
        ['PATCH', `/systems/${id}`, { name: 'x' }],
        ['DELETE', `/systems/${id}`],
        ['GET', `/systems/${id}/relationships`],
        ['POST', `/systems/${id}/relationships/discover`],
        ['POST', `/systems/${id}/repositories`, { owner: 'acme', repository: 'web' }],
        ['DELETE', `/systems/${id}/repositories/acme/web`],
        ['POST', `/systems/${id}/find-api-consumers`, { path: '/api/users' }],
      ] as const) {
        const res = await call(both, b.ws, method, path, body);
        expect(res.status).toBe(404); // a system id is not a credential, and no existence oracle
        expect(res.body.code).toBe('SYSTEM_CONTEXT_NOT_CONFIGURED');
      }
      expect((await prisma.projectSystem.findUniqueOrThrow({ where: { id } })).name).toContain(
        'Payments',
      );
      expect(await prisma.repositoryRelationship.count({ where: { systemId: id } })).toBe(1);
      // Through A it is all there.
      expect((await call(both, a.ws, 'GET', `/systems/${id}/relationships`)).body).toHaveLength(1);
    });

    it('relationships are per user and per workspace: a member never sees another user’s findings', async () => {
      const { ws, users } = await seed({ owner: 'owner', member: 'member' });
      const id = await systemIn(ws, users.owner!);
      await relationship(users.owner!, ws, id);
      expect(
        (await call(users.owner!, ws, 'GET', `/systems/${id}/relationships`)).body,
      ).toHaveLength(1);
      expect((await call(users.member!, ws, 'GET', `/systems/${id}/relationships`)).body).toEqual(
        [],
      );
    });

    it('downstream impact (PR Review path) is limited to the caller’s workspace and permission', async () => {
      const a = await seed({ owner: 'owner', member: 'member' });
      const id = await systemIn(a.ws, a.users.owner!);
      await relationship(a.users.owner!, a.ws, id);
      const changes: never[] = [];
      const allowed = await contractImpact.computeForProvider(a.users.owner!, a.ws, {
        owner: 'acme',
        repository: 'api',
        changes,
      });
      expect(allowed.systemsConsidered).toBe(1);

      const other = await seed({ owner: 'owner' });
      const crossTenant = await contractImpact.computeForProvider(other.users.owner!, a.ws, {
        owner: 'acme',
        repository: 'api',
        changes,
      });
      expect(crossTenant.systemsConsidered).toBe(0); // not a member of A: nothing considered

      await prisma.workspace.update({ where: { id: a.ws }, data: { status: 'deletion_pending' } });
      expect(
        (
          await contractImpact.computeForProvider(a.users.owner!, a.ws, {
            owner: 'acme',
            repository: 'api',
            changes,
          })
        ).systemsConsidered,
      ).toBe(0);
    });

    it('history: consumer visibility requires systems:read in that workspace (fails closed)', async () => {
      const { ws, users, memberships } = await seed({ owner: 'owner' });
      expect(await contractImpact.canReadSystems(users.owner!, ws)).toBe(true);
      await prisma.workspaceMembership.update({
        where: { id: memberships.owner },
        data: { status: 'removed' },
      });
      expect(await contractImpact.canReadSystems(users.owner!, ws)).toBe(false);
      const unwired = new ContractImpactService(prisma as never, {} as never);
      expect(await unwired.canReadSystems(users.owner!, ws)).toBe(false);
    });
  });

  // ── H1 inside Systems ────────────────────────────────────────────────────

  describe('GitHub H1 is enforced by Systems operations', () => {
    it('an Admin cannot link a repository they cannot read, even though the App covers it', async () => {
      const { ws, users } = await seed({ owner: 'owner', admin: 'admin' }, { installation: true });
      const id = await systemIn(ws, users.owner!);
      const res = await call(users.admin!, ws, 'POST', `/systems/${id}/repositories`, {
        owner: 'acme',
        repository: 'secret',
      });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('SYSTEM_REPOSITORY_NOT_ACCESSIBLE');
      const created = await call(users.admin!, ws, 'POST', '/systems', {
        name: 'Secret',
        primaryOwner: 'acme',
        primaryRepository: 'secret',
      });
      expect(created.status).toBe(403);
    });

    it('without a personal token the App access is not inherited', async () => {
      const { ws, users } = await seed(
        { owner: 'owner', admin: 'admin' },
        { installation: true, tokenless: ['admin'] },
      );
      const id = await systemIn(ws, users.owner!);
      const res = await call(users.admin!, ws, 'POST', `/systems/${id}/repositories`, {
        owner: 'acme',
        repository: 'secret',
      });
      expect(res.status).toBe(403);
      expect(String(res.body.message)).toContain('Connect your own GitHub token');
    });

    it('authorized linking works, and revoking GitHub access blocks the next attempt', async () => {
      const { ws, users } = await seed({ owner: 'owner' }, { installation: true });
      const owner = users.owner!;
      const id = await systemIn(ws, owner);
      USER_REPOS[owner]!.add('acme/secret');
      expect(
        (
          await call(owner, ws, 'POST', `/systems/${id}/repositories`, {
            owner: 'acme',
            repository: 'secret',
          })
        ).status,
      ).toBe(201);
      expect(
        (await call(owner, ws, 'DELETE', `/systems/${id}/repositories/acme/secret`)).status,
      ).toBe(200);
      USER_REPOS[owner]!.delete('acme/secret'); // revoked on GitHub
      expect(
        (
          await call(owner, ws, 'POST', `/systems/${id}/repositories`, {
            owner: 'acme',
            repository: 'secret',
          })
        ).status,
      ).toBe(403);
    });

    it('discovery never scans repositories the member cannot read (reported unavailable)', async () => {
      const { ws, users } = await seed(
        { owner: 'owner', member: 'member' },
        { installation: true },
      );
      const id = await systemIn(ws, users.owner!);
      USER_REPOS[users.member!] = new Set(['acme/api']); // cannot read acme/web
      const res = await call(users.member!, ws, 'POST', `/systems/${id}/relationships/discover`);
      expect(res.status).toBe(201);
      const scan = res.body.scan as {
        repositories: Array<{ repository: { repository: string }; status: string }>;
      };
      const web = scan.repositories.find((r) => r.repository.repository === 'web');
      expect(web?.status).toBe('unavailable');
    });
  });

  // ── N-9: quota abuse ─────────────────────────────────────────────────────────────────────

  describe('N-9: Discover / Refresh / analyze are rate limited per user (and per workspace)', () => {
    it('a Member looping Discover gets a stable 429 before any GitHub call or usage charge', async () => {
      const { ws, users } = await seed({ owner: 'owner', member: 'member' });
      const id = await systemIn(ws, users.owner!);
      for (let i = 0; i < 10; i += 1) {
        const ok = await call(users.member!, ws, 'POST', `/systems/${id}/relationships/discover`);
        expect(ok.status).toBe(201);
      }
      const usageBefore = await prisma.workspaceUsageCounter.findMany({
        where: { workspaceId: ws },
      });
      githubCalls.length = 0;
      for (const path of [`/systems/${id}/relationships/discover`, `/systems/${id}/refresh`]) {
        const limited = await call(users.member!, ws, 'POST', path);
        expect(limited.status).toBe(429);
        expect(limited.body.code).toBe('RATE_LIMITED');
      }
      expect(githubCalls).toEqual([]); // rejected before any GitHub request
      expect(await prisma.workspaceUsageCounter.findMany({ where: { workspaceId: ws } })).toEqual(
        usageBefore,
      ); // nothing charged
      // Members keep systems:read: another member is not affected by this member's limit.
      const other = await call(users.owner!, ws, 'POST', `/systems/${id}/relationships/discover`);
      expect(other.status).toBe(201);
    });

    it('an unauthorized user is refused by authorization, never consuming the rate budget', async () => {
      const { ws, users } = await seed({ owner: 'owner' });
      const id = await systemIn(ws, users.owner!);
      const outsider = (await seed({ owner: 'owner' })).users.owner!;
      rateCounters.clear();
      expect(
        (await call(outsider, ws, 'POST', `/systems/${id}/relationships/discover`)).status,
      ).toBe(403);
      expect([...rateCounters.keys()]).toEqual([]);
    });
  });
});
