/**
 * Project Memory — role permissions over real HTTP (Private Beta QA).
 *
 * Boots the real ProjectMemoryController with the production request pipeline pieces that
 * matter for authorization: RequestContextMiddleware (X-Workspace-Id → ALS),
 * ObservabilityExceptionFilter (error → HTTP status/body), and the global ValidationPipe.
 * Service, WorkspaceAuthorizationService, FeatureGate and PostgreSQL are real.
 *
 * Stubbed: JWT (test guard reads `x-test-user`), GitHub repository access (always allowed),
 * Redis (in-memory), GitHub content. Run via `pnpm --filter @project-x/api test:integration`.
 */
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

import { JwtAuthGuard } from '../../src/auth/jwt-auth.guard';
import { EntitlementService } from '../../src/entitlements/entitlements.service';
import { FeatureGate } from '../../src/entitlements/feature-gate';
import { ObservabilityExceptionFilter } from '../../src/observability/observability-exception.filter';
import { RequestContextMiddleware } from '../../src/observability/request-context.middleware';
import { RequestContextService } from '../../src/observability/request-context.service';
import { ProjectMemoryController } from '../../src/project-memory/project-memory.controller';
import { ProjectMemoryService } from '../../src/project-memory/project-memory.service';
import { WorkspaceAuthorizationService } from '../../src/workspaces/workspace-authorization.service';

const URL_ENV = process.env.MEMORY_IT_DATABASE_URL;
const OWNER = 'acme';
const REPO = 'payments';
const BASE = `/api/projects/${OWNER}/${REPO}/memory`;

type Role = 'owner' | 'admin' | 'member';

describe.skipIf(!URL_ENV)('Project Memory permissions over HTTP', () => {
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
    const requestContext = new RequestContextService();
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
    // GitHub repository-access check always succeeds; local HTTP goes to the real fetch.
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).startsWith('https://api.github.com/')
        ? Response.json({ id: 1 }, { status: 200 })
        : realFetch(input, init),
    ) as typeof fetch;
  });

  // ── helpers ──────────────────────────────────────────────────────────────

  async function seed(roles: Record<string, Role>) {
    run += 1;
    const ws = `ws_http_${run}`;
    await prisma.workspace.create({ data: { id: ws, name: ws, slug: ws } });
    await prisma.workspaceSubscription.create({
      data: { workspaceId: ws, provider: 'paddle', planId: 'pro', status: 'active' },
    });
    const users: Record<string, string> = {};
    for (const [name, role] of Object.entries(roles)) {
      const id = `http_${name}_${run}`;
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

  const createShared = (user: string, text = 'Webhook handlers must be idempotent.', h = {}) =>
    call(user, 'POST', `${BASE}/rules`, { category: 'PROJECT_CONSTRAINT', key: 'pay.wh', text }, h);

  async function statusOf(id: string) {
    return (await prisma.projectMemory.findUnique({ where: { id } }))!.status;
  }

  // ── 1 & 2: owner / admin full lifecycle ──────────────────────────────────

  for (const role of ['owner', 'admin'] as const) {
    it(`[1/2] ${role} can create, read, archive and reactivate workspace memory over HTTP`, async () => {
      const { users } = await seed({ actor: role, ...(role === 'admin' ? { o: 'owner' } : {}) });
      const u = users.actor!;

      const created = await createShared(u);
      expect(created.status).toBe(201);
      const id = created.body.id as string;

      const listed = await call(u, 'GET', BASE);
      expect(listed.status).toBe(200);
      expect((listed.body.items as { id: string }[]).map((i) => i.id)).toContain(id);

      const archived = await call(u, 'DELETE', `${BASE}/${id}`);
      expect(archived.status).toBe(200);
      expect(await statusOf(id)).toBe('archived');

      const reactivated = await call(u, 'PATCH', `${BASE}/${id}`, { status: 'active' });
      expect(reactivated.status).toBe(200);
      expect(await statusOf(id)).toBe('active');
    });
  }

  // ── 3: member reads, cannot modify shared rules ─────────────────────────

  it('[3] member can read shared rules (list, profile, summary) but every shared mutation is 403', async () => {
    const { users } = await seed({ owner: 'owner', member: 'member' });
    const live = (await createShared(users.owner!)).body.id as string;
    const toArchive = (
      await call(users.owner!, 'POST', `${BASE}/rules`, {
        category: 'CODE_CONVENTION',
        key: 'style.x',
        text: 'Use named exports.',
      })
    ).body.id as string;
    await call(users.owner!, 'DELETE', `${BASE}/${toArchive}`);

    const m = users.member!;
    const list = await call(m, 'GET', BASE);
    expect(list.status).toBe(200);
    expect((list.body.items as { id: string }[]).map((i) => i.id)).toEqual([live]);
    expect((await call(m, 'GET', `${BASE}/profile`)).status).toBe(200);
    expect((await call(m, 'GET', `${BASE}/summary?capability=PR_REVIEW`)).status).toBe(200);

    const attempts = [
      await createShared(m, 'Member shared rule.'),
      await call(m, 'PATCH', `${BASE}/${live}`, { text: 'member edit' }),
      await call(m, 'PATCH', `${BASE}/${live}`, { status: 'archived' }),
      await call(m, 'DELETE', `${BASE}/${live}`),
      await call(m, 'PATCH', `${BASE}/${toArchive}`, { status: 'active' }),
      await call(m, 'POST', `${BASE}/clear`, { confirm: true }),
      await call(m, 'POST', `${BASE}/learn`),
      await call(m, 'POST', `${BASE}/candidates/confirm`, { candidateId: 'cand_x' }),
    ];
    for (const a of attempts) {
      expect(a.status).toBe(403);
      expect(a.body.code).toBe('WORKSPACE_ACCESS_DENIED');
    }
    expect(await statusOf(live)).toBe('active');
    expect(await statusOf(toArchive)).toBe('archived');

    // Personal preference is still allowed (author-only, not a shared rule).
    const pref = await call(m, 'POST', `${BASE}/rules`, {
      category: 'USER_PREFERENCE',
      text: 'Prefer short summaries.',
    });
    expect(pref.status).toBe(201);
  });

  // ── 4: non-members ───────────────────────────────────────────────────────

  it('[4] a user from another workspace cannot read or mutate workspace A memory', async () => {
    const a = await seed({ owner: 'owner' });
    const b = await seed({ outsider: 'owner' });
    const id = (await createShared(a.users.owner!)).body.id as string;
    const o = b.users.outsider!;

    const list = await call(o, 'GET', BASE);
    expect(list.status).toBe(200);
    expect(list.body.items).toEqual([]);
    const summary = await call(o, 'GET', `${BASE}/summary?capability=PR_REVIEW`);
    expect(summary.body.relevantRules).toEqual([]);

    expect((await call(o, 'DELETE', `${BASE}/${id}`)).status).toBe(404);
    expect((await call(o, 'PATCH', `${BASE}/${id}`, { text: 'pwn' })).status).toBe(404);
    expect(await statusOf(id)).toBe('active');
  });

  it('[4] a user with no workspace membership at all gets no memory access', async () => {
    const a = await seed({ owner: 'owner' });
    const id = (await createShared(a.users.owner!)).body.id as string;
    run += 1;
    const loner = `http_loner_${run}`;
    await prisma.user.create({ data: { id: loner, email: `${loner}@it.test`, passwordHash: 'x' } });

    const list = await call(loner, 'GET', BASE, undefined, { 'x-workspace-id': a.ws });
    expect(list.status).toBe(403);
    expect(list.body.code).toBe('WORKSPACE_CONTEXT_UNAVAILABLE');
    const del = await call(loner, 'DELETE', `${BASE}/${id}`, undefined, { 'x-workspace-id': a.ws });
    expect(del.status).toBe(403);
    expect(await statusOf(id)).toBe('active');
  });

  // ── 5: tampering with workspaceId / memory ids ───────────────────────────

  it('[5] spoofing X-Workspace-Id to a foreign workspace grants nothing', async () => {
    const a = await seed({ owner: 'owner' });
    const b = await seed({ attacker: 'owner' });
    const id = (await createShared(a.users.owner!)).body.id as string;
    const hdr = { 'x-workspace-id': a.ws };
    const x = b.users.attacker!;

    const scope = { where: { userId: { in: [a.users.owner!, x] } } };
    const before = await prisma.projectMemory.count(scope);

    // An explicitly selected workspace the caller cannot use is rejected outright — it is
    // neither honoured (A) nor silently swapped for the caller's own workspace (B).
    const attempts = [
      await call(x, 'GET', BASE, undefined, hdr),
      await call(x, 'DELETE', `${BASE}/${id}`, undefined, hdr),
      await call(x, 'PATCH', `${BASE}/${id}`, { status: 'archived' }, hdr),
      await createShared(x, 'Injected into A?', hdr),
    ];
    for (const a of attempts) {
      expect(a.status).toBe(403);
      expect(a.body.code).toBe('WORKSPACE_CONTEXT_UNAVAILABLE');
    }
    expect(await prisma.projectMemory.count(scope)).toBe(before);
    expect(await statusOf(id)).toBe('active');
  });

  it('[5] owner of B / member of A cannot use B role against A rules by switching header', async () => {
    const a = await seed({ owner: 'owner' });
    const b = await seed({ dual: 'owner' });
    const dual = b.users.dual!;
    await prisma.workspaceMembership.create({
      data: { workspaceId: a.ws, userId: dual, role: 'member', status: 'active' },
    });
    const id = (await createShared(a.users.owner!)).body.id as string;

    // Acting in B (owner there): A's id is not addressable.
    const inB = await call(dual, 'DELETE', `${BASE}/${id}`, undefined, { 'x-workspace-id': b.ws });
    expect(inB.status).toBe(404);
    // Acting in A: readable, but member role → 403.
    const listA = await call(dual, 'GET', BASE, undefined, { 'x-workspace-id': a.ws });
    expect((listA.body.items as { id: string }[]).map((i) => i.id)).toContain(id);
    const inA = await call(dual, 'DELETE', `${BASE}/${id}`, undefined, { 'x-workspace-id': a.ws });
    expect(inA.status).toBe(403);
    expect(await statusOf(id)).toBe('active');
  });

  it('[5] a valid memory id under a different owner/repo path is not found', async () => {
    const { users } = await seed({ owner: 'owner' });
    const id = (await createShared(users.owner!)).body.id as string;
    const other = `/api/projects/${OWNER}/other-repo/memory/${id}`;
    expect((await call(users.owner!, 'DELETE', other)).status).toBe(404);
    expect(
      (await call(users.owner!, 'GET', '/api/projects/acme/other-repo/memory')).body.items,
    ).toEqual([]);
    expect(await statusOf(id)).toBe('active');
  });

  // ── 6: managing another user's rule ──────────────────────────────────────

  it("[6] owner and admin can manage each other's rules", async () => {
    const { users } = await seed({ owner: 'owner', admin: 'admin' });
    const byOwner = (await createShared(users.owner!)).body.id as string;
    const byAdmin = (
      await call(users.admin!, 'POST', `${BASE}/rules`, {
        category: 'CODE_CONVENTION',
        key: 'style.y',
        text: 'Prefer early returns.',
      })
    ).body.id as string;

    expect(
      (await call(users.admin!, 'PATCH', `${BASE}/${byOwner}`, { text: 'admin edit' })).status,
    ).toBe(200);
    expect((await call(users.admin!, 'DELETE', `${BASE}/${byOwner}`)).status).toBe(200);
    expect(
      (await call(users.admin!, 'PATCH', `${BASE}/${byOwner}`, { status: 'active' })).status,
    ).toBe(200);
    expect((await call(users.owner!, 'DELETE', `${BASE}/${byAdmin}`)).status).toBe(200);
    expect(
      (await call(users.owner!, 'PATCH', `${BASE}/${byAdmin}`, { status: 'active' })).status,
    ).toBe(200);
  });

  // ── 7: archived memory excluded from AI context ──────────────────────────

  it('[7] archived memory is not injected into AI context and is absent from summary', async () => {
    const { ws, users } = await seed({ owner: 'owner', member: 'member' });
    const id = (await createShared(users.owner!, 'Never deploy on Fridays.')).body.id as string;
    const ctx = (userId: string) =>
      memory.resolvePromptContext({
        userId,
        workspaceId: ws,
        owner: OWNER,
        repository: REPO,
        capability: 'PR_REVIEW',
      } as never);

    const before = await ctx(users.member!);
    expect(before.status).toBe('applied');
    expect((before as { block: string }).block).toContain('Never deploy on Fridays.');

    await call(users.owner!, 'DELETE', `${BASE}/${id}`);
    const after = await ctx(users.member!);
    expect(after.status).toBe('skipped');
    expect(JSON.stringify(after)).not.toContain('Never deploy on Fridays.');
    const summary = await call(users.member!, 'GET', `${BASE}/summary?capability=PR_REVIEW`);
    expect(summary.body.relevantRules).toEqual([]);
  });

  // ── 8: invalid / inaccessible / stale X-Workspace-Id never falls back ────

  describe('[8] invalid X-Workspace-Id', () => {
    /** Every read and mutation entry point, each tried with the given header. */
    async function everyEndpoint(user: string, memoryId: string, hdr: Record<string, string>) {
      return [
        await call(user, 'GET', BASE, undefined, hdr),
        await call(user, 'GET', `${BASE}?status=archived`, undefined, hdr),
        await call(user, 'GET', `${BASE}/profile`, undefined, hdr),
        await call(user, 'GET', `${BASE}/summary?capability=PR_REVIEW`, undefined, hdr),
        await createShared(user, 'Should never be stored.', hdr),
        await call(user, 'POST', `${BASE}/rules`, { category: 'USER_PREFERENCE', text: 'p' }, hdr),
        await call(user, 'PATCH', `${BASE}/${memoryId}`, { text: 'changed' }, hdr),
        await call(user, 'PATCH', `${BASE}/${memoryId}`, { status: 'active' }, hdr),
        await call(user, 'DELETE', `${BASE}/${memoryId}`, undefined, hdr),
        await call(user, 'POST', `${BASE}/clear`, { confirm: true }, hdr),
      ];
    }

    /** Rows authored by the test's users (the other PG spec may write concurrently). */
    async function snapshot(userIds: string[]) {
      return prisma.projectMemory.findMany({
        where: { userId: { in: userIds } },
        orderBy: { id: 'asc' },
        select: { id: true, status: true, valueJson: true, workspaceId: true },
      });
    }

    it.each([
      ['malformed', 'ws bad/../id', 400, 'WORKSPACE_ID_INVALID'],
      ['over-long', 'w'.repeat(65), 400, 'WORKSPACE_ID_INVALID'],
      ['nonexistent', 'ws_does_not_exist', 403, 'WORKSPACE_CONTEXT_UNAVAILABLE'],
    ])('%s header → %s %s, nothing mutated', async (_label, header, status, code) => {
      const { users } = await seed({ owner: 'owner' });
      const o = users.owner!;
      const id = (await createShared(o)).body.id as string;
      await call(o, 'DELETE', `${BASE}/${id}`); // archived, so reactivation is a real mutation
      const before = await snapshot([o]);

      for (const res of await everyEndpoint(o, id, { 'x-workspace-id': header })) {
        expect(res.status).toBe(status);
        expect(res.body.code).toBe(code);
      }
      expect(await snapshot([o])).toEqual(before);
    });

    it('stale header (membership removed) → 403, never falls back to the other workspace', async () => {
      const home = await seed({ u: 'owner' });
      const other = await seed({ o: 'owner' });
      const u = home.users.u!;
      // u was an admin of `other`, then removed; dashboard still holds `other` as selection.
      await prisma.workspaceMembership.create({
        data: { workspaceId: other.ws, userId: u, role: 'admin', status: 'removed' },
      });
      const homeRule = (await createShared(u, 'Home rule.')).body.id as string;
      await call(u, 'DELETE', `${BASE}/${homeRule}`);
      const otherRule = (await createShared(other.users.o!, 'Other ws rule.')).body.id as string;
      const before = await snapshot([u, other.users.o!]);

      for (const res of await everyEndpoint(u, homeRule, { 'x-workspace-id': other.ws })) {
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('WORKSPACE_CONTEXT_UNAVAILABLE');
      }
      expect(await snapshot([u, other.users.o!])).toEqual(before);
      expect(await statusOf(homeRule)).toBe('archived');
      expect(await statusOf(otherRule)).toBe('active');
    });

    it('stale header (workspace deactivated) → 403, nothing mutated', async () => {
      const home = await seed({ u: 'owner' });
      const dead = await seed({ x: 'owner' });
      const u = home.users.u!;
      await prisma.workspaceMembership.create({
        data: { workspaceId: dead.ws, userId: u, role: 'owner', status: 'active' },
      });
      const id = (await createShared(u, 'Rule in dead ws.', { 'x-workspace-id': dead.ws })).body
        .id as string;
      await prisma.workspace.update({ where: { id: dead.ws }, data: { status: 'suspended' } });
      const before = await snapshot([u, dead.users.x!]);

      for (const res of await everyEndpoint(u, id, { 'x-workspace-id': dead.ws })) {
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('WORKSPACE_CONTEXT_UNAVAILABLE');
      }
      expect(await snapshot([u, dead.users.x!])).toEqual(before);
    });

    it('absent or blank header keeps the documented fallback (lastWorkspaceId)', async () => {
      const { ws, users } = await seed({ owner: 'owner' });
      for (const hdr of [{}, { 'x-workspace-id': '   ' }]) {
        const created = await createShared(users.owner!, 'Fallback rule.', hdr);
        expect(created.status).toBe(201);
        const row = await prisma.projectMemory.findUnique({
          where: { id: created.body.id as string },
        });
        expect(row!.workspaceId).toBe(ws);
        expect((await call(users.owner!, 'GET', BASE, undefined, hdr)).status).toBe(200);
      }
    });
  });

  // ── 9: archived memory lifecycle & reactivation authorization ────────────

  describe('[9] archived lifecycle and reactivation', () => {
    const ids = (res: { body: Record<string, unknown> }) =>
      ((res.body.items ?? []) as { id: string }[]).map((i) => i.id);

    it('archive → listed only under ?status=archived → reactivate → active and back in AI context', async () => {
      const { ws, users } = await seed({ admin: 'admin', o: 'owner', member: 'member' });
      const a = users.admin!;
      const id = (await createShared(a, 'Always validate webhook signatures.')).body.id as string;
      const ctx = () =>
        memory.resolvePromptContext({
          userId: users.member!,
          workspaceId: ws,
          owner: OWNER,
          repository: REPO,
          capability: 'PR_REVIEW',
        } as never);

      expect((await call(a, 'DELETE', `${BASE}/${id}`)).status).toBe(200);
      expect(ids(await call(a, 'GET', BASE))).not.toContain(id);
      const archived = await call(a, 'GET', `${BASE}?status=archived`);
      expect(archived.status).toBe(200);
      expect(ids(archived)).toEqual([id]);
      // Members can see the archived shared rule (read), but not act on it.
      expect(ids(await call(users.member!, 'GET', `${BASE}?status=archived`))).toEqual([id]);
      expect((await ctx()).status).toBe('skipped');

      const re = await call(a, 'PATCH', `${BASE}/${id}`, { status: 'active' });
      expect(re.status).toBe(200);
      expect(re.body.status).toBe('active');
      expect(ids(await call(a, 'GET', BASE))).toContain(id);
      expect(ids(await call(a, 'GET', `${BASE}?status=archived`))).toEqual([]);
      const after = await ctx();
      expect(after.status).toBe('applied');
      expect((after as { block: string }).block).toContain('Always validate webhook signatures.');
    });

    it('reactivating supersedes the rule currently holding the same key (one active per slot)', async () => {
      const { users } = await seed({ owner: 'owner' });
      const o = users.owner!;
      const old = (await createShared(o, 'Old wording.')).body.id as string;
      await call(o, 'DELETE', `${BASE}/${old}`);
      const current = (await createShared(o, 'New wording.')).body.id as string;

      expect((await call(o, 'PATCH', `${BASE}/${old}`, { status: 'active' })).status).toBe(200);
      expect(await statusOf(old)).toBe('active');
      expect(await statusOf(current)).toBe('superseded');
      expect(ids(await call(o, 'GET', BASE))).toEqual([old]);
    });

    it('member cannot reactivate an archived shared rule (403), even with own workspace header', async () => {
      const { ws, users } = await seed({ owner: 'owner', member: 'member' });
      const id = (await createShared(users.owner!)).body.id as string;
      await call(users.owner!, 'DELETE', `${BASE}/${id}`);

      for (const hdr of [{}, { 'x-workspace-id': ws }]) {
        const res = await call(users.member!, 'PATCH', `${BASE}/${id}`, { status: 'active' }, hdr);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('WORKSPACE_ACCESS_DENIED');
      }
      expect(await statusOf(id)).toBe('archived');
    });

    it('outsiders cannot see or reactivate archived rules of another workspace', async () => {
      const a = await seed({ owner: 'owner' });
      const b = await seed({ outsider: 'owner' });
      const id = (await createShared(a.users.owner!)).body.id as string;
      await call(a.users.owner!, 'DELETE', `${BASE}/${id}`);
      const o = b.users.outsider!;

      expect(ids(await call(o, 'GET', `${BASE}?status=archived`))).toEqual([]);
      expect((await call(o, 'PATCH', `${BASE}/${id}`, { status: 'active' })).status).toBe(404);
      const spoofed = await call(
        o,
        'PATCH',
        `${BASE}/${id}`,
        { status: 'active' },
        {
          'x-workspace-id': a.ws,
        },
      );
      expect(spoofed.status).toBe(403);
      expect(await statusOf(id)).toBe('archived');
    });

    it('personal preferences: author (any role) may reactivate; nobody else can see or touch them', async () => {
      const { users } = await seed({ owner: 'owner', admin: 'admin', m1: 'member', m2: 'member' });
      const pref = (
        await call(users.m1!, 'POST', `${BASE}/rules`, {
          category: 'USER_PREFERENCE',
          text: 'Keep review comments terse.',
        })
      ).body.id as string;
      expect((await call(users.m1!, 'DELETE', `${BASE}/${pref}`)).status).toBe(200);

      // Only the author sees their archived preference.
      expect(ids(await call(users.m1!, 'GET', `${BASE}?status=archived`))).toEqual([pref]);
      for (const other of [users.owner!, users.admin!, users.m2!]) {
        expect(ids(await call(other, 'GET', `${BASE}?status=archived`))).toEqual([]);
        const res = await call(other, 'PATCH', `${BASE}/${pref}`, { status: 'active' });
        expect(res.status).toBe(404);
      }
      expect(await statusOf(pref)).toBe('archived');

      // The author (a member) can reactivate their own preference.
      const re = await call(users.m1!, 'PATCH', `${BASE}/${pref}`, { status: 'active' });
      expect(re.status).toBe(200);
      expect(await statusOf(pref)).toBe('active');
    });
  });
});
