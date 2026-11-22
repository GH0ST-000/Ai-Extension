/**
 * Project Memory audit log — PostgreSQL + real HTTP.
 *
 * Real: PostgreSQL (migrations incl. the append-only trigger), ProjectMemoryController +
 * ProjectMemoryAuditController, ProjectMemoryService (writes + atomic audit), audit read
 * service, WorkspaceGuard + WorkspaceAuthorizationService, FeatureGate/Entitlements,
 * ValidationPipe (main.ts options), RequestContext middleware (request id, X-Workspace-Id),
 * exception filter. Stubbed: JWT (x-test-user), GitHub repository access (allowed), GitHub
 * file content (Learn), Redis (in-memory).
 */
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import type { ProjectMemoryAuditEvent, ProjectMemoryAuditRuleSummary } from '@project-x/types';
import type { NextFunction, Request, Response } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { JwtAuthGuard } from '../../src/auth/jwt-auth.guard';
import { EntitlementService } from '../../src/entitlements/entitlements.service';
import { FeatureGate } from '../../src/entitlements/feature-gate';
import { ObservabilityExceptionFilter } from '../../src/observability/observability-exception.filter';
import { RequestContextMiddleware } from '../../src/observability/request-context.middleware';
import { RequestContextService } from '../../src/observability/request-context.service';
import { ProjectMemoryAuditController } from '../../src/project-memory/audit/project-memory-audit.controller';
import { ProjectMemoryAuditService } from '../../src/project-memory/audit/project-memory-audit.service';
import { ProjectMemoryController } from '../../src/project-memory/project-memory.controller';
import { ProjectMemoryService } from '../../src/project-memory/project-memory.service';
import { WorkspaceAuthorizationService } from '../../src/workspaces/workspace-authorization.service';
import { WorkspaceGuard } from '../../src/workspaces/workspace.guard';
import { repositoryAccessStub } from '../../src/github-app/github-access.test-helpers';

const URL_ENV = process.env.MEMORY_IT_DATABASE_URL;
const OWNER = 'acme';
const REPO = 'payments';
const MEM = `/api/projects/${OWNER}/${REPO}/memory`;

type Role = 'owner' | 'admin' | 'member';
type Page = { items: ProjectMemoryAuditEvent[]; nextCursor: string | null };

describe.skipIf(!URL_ENV)('Project Memory audit log (PostgreSQL + HTTP)', () => {
  let prisma: PrismaClient;
  let app: INestApplication;
  let baseUrl: string;
  let memory: ProjectMemoryService;
  const realFetch = globalThis.fetch;
  const learnFiles = new Map<string, string>();
  let run = 0;

  beforeAll(async () => {
    const url = new URL(URL_ENV!);
    if (!url.pathname.endsWith('_it') || url.port === '5432') {
      throw new Error(`Refusing to run integration tests against ${url.host}${url.pathname}`);
    }
    prisma = new PrismaClient({ datasourceUrl: URL_ENV });
    await prisma.$connect();

    const requestContext = new RequestContextService();
    const featureGate = new FeatureGate(new EntitlementService(prisma as never));
    const authorization = new WorkspaceAuthorizationService(prisma as never);
    const redisStore = new Map<string, string>();
    memory = new ProjectMemoryService(
      prisma as never,
      {
        get: vi.fn(async (k: string) => redisStore.get(k) ?? null),
        set: vi.fn(async (k: string, v: string) => redisStore.set(k, v)),
        del: vi.fn(async (k: string) => redisStore.delete(k)),
      } as never,
      repositoryAccessStub({
        getDecryptedToken: vi.fn(async () => 'ghp_integration_token'),
      }) as never,
      {
        fetchRepositoryFileAtRef: vi.fn(
          async (_u: string, _o: string, _r: string, path: string) => learnFiles.get(path) ?? null,
        ),
      } as never,
      featureGate,
      authorization,
      requestContext,
    );
    const audit = new ProjectMemoryAuditService(prisma as never, featureGate, requestContext);

    const moduleRef = await Test.createTestingModule({
      controllers: [ProjectMemoryController, ProjectMemoryAuditController],
      providers: [
        { provide: ProjectMemoryService, useValue: memory },
        { provide: ProjectMemoryAuditService, useValue: audit },
        { provide: WorkspaceAuthorizationService, useValue: authorization },
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
    learnFiles.clear();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).startsWith('https://api.github.com/')
        ? Response.json({ id: 1 }, { status: 200 })
        : realFetch(input, init),
    ) as typeof fetch;
  });

  // ── helpers ──────────────────────────────────────────────────────────────

  async function seed(roles: Record<string, Role>, planId = 'team') {
    run += 1;
    const tag = `${run}_${Date.now()}`;
    const ws = `ws_audit_${tag}`;
    await prisma.workspace.create({ data: { id: ws, name: ws, slug: ws } });
    await prisma.workspaceSubscription.create({
      data: { workspaceId: ws, provider: 'paddle', planId, status: 'active' },
    });
    const users: Record<string, string> = {};
    for (const [name, role] of Object.entries(roles)) {
      const id = `audit_${name}_${tag}`;
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
    }
    return { ws, users };
  }

  async function call(
    user: string | null,
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await realFetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(user ? { 'x-test-user': user } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  }

  const createRule = (
    user: string,
    text: string,
    key = 'pay.wh',
    category = 'PROJECT_CONSTRAINT',
  ) => call(user, 'POST', `${MEM}/rules`, { category, key, text });

  async function events(user: string, ws: string, query = ''): Promise<ProjectMemoryAuditEvent[]> {
    const res = await call(user, 'GET', `/api/workspaces/${ws}/memory/audit?limit=100${query}`);
    expect(res.status).toBe(200);
    return (res.body as unknown as Page).items;
  }

  const dbEvents = (ws: string) =>
    prisma.projectMemoryAuditEvent.findMany({
      where: { workspaceId: ws },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

  // ── every supported event, attributed and with safe state ────────────────

  it('records every lifecycle event with actor, type, reason, states and request id', async () => {
    const { ws, users } = await seed({ owner: 'owner' });
    const u = users.owner!;
    const a = (await createRule(u, 'Webhook handlers must be idempotent.')).body.id as string;

    expect(
      (
        await call(u, 'PATCH', `${MEM}/${a}`, {
          text: 'Webhook handlers must be idempotent and logged.',
        })
      ).status,
    ).toBe(200);
    expect((await call(u, 'PATCH', `${MEM}/${a}`, { status: 'disputed' })).status).toBe(200);
    expect((await call(u, 'PATCH', `${MEM}/${a}`, { status: 'active' })).status).toBe(200);
    expect((await call(u, 'DELETE', `${MEM}/${a}`)).status).toBe(200);
    expect((await call(u, 'PATCH', `${MEM}/${a}`, { status: 'active' })).status).toBe(200);
    // Same slot, different text → the old rule is superseded by a new one (system + user).
    const b = (await createRule(u, 'Webhooks must verify signatures first.')).body.id as string;
    // Same slot, same text → reconfirmed, no new row.
    expect((await createRule(u, 'Webhooks must verify signatures first.')).body.id).toBe(b);
    // Reactivating A takes the slot back: B is superseded automatically.
    expect((await call(u, 'PATCH', `${MEM}/${a}`, { status: 'active' })).status).toBe(200);
    // Explicit status change to superseded by a user.
    expect((await call(u, 'PATCH', `${MEM}/${a}`, { status: 'superseded' })).status).toBe(200);

    const all = (await events(u, ws)).reverse(); // oldest first
    expect(
      all.map((e) => [e.eventType, e.memoryId === a ? 'A' : 'B', e.actorType, e.reason]),
    ).toEqual([
      ['rule_created', 'A', 'user', 'user_rule'],
      ['rule_edited', 'A', 'user', 'user_rule'],
      ['rule_disputed', 'A', 'user', 'status_change'],
      ['rule_restored', 'A', 'user', 'status_change'],
      ['rule_archived', 'A', 'user', 'status_change'],
      ['rule_reactivated', 'A', 'user', 'status_change'],
      ['rule_superseded', 'A', 'system', 'replaced_by_new_rule'],
      ['rule_created', 'B', 'user', 'user_rule'],
      ['rule_reconfirmed', 'B', 'user', 'user_rule'],
      ['rule_superseded', 'B', 'system', 'slot_reactivated'],
      ['rule_reactivated', 'A', 'user', 'status_change'],
      ['rule_superseded', 'A', 'user', 'status_change'],
    ]);
    const edited = all[1]!;
    expect(edited.previousState).toMatchObject({
      text: 'Webhook handlers must be idempotent.',
      status: 'active',
    });
    expect(edited.newState).toMatchObject({
      text: 'Webhook handlers must be idempotent and logged.',
    });
    expect(all[6]!.relatedMemoryId).toBe(b);
    expect(all[7]!.relatedMemoryId).toBe(a);
    expect(all[9]!.relatedMemoryId).toBe(a);
    for (const e of all) {
      expect(e.actorUserId).toBe(u);
      expect(e.actorName).toBe('User owner');
      expect(e.actorIsViewer).toBe(true);
      expect(e.requestId).toBeTruthy();
      expect(e.owner).toBe(OWNER);
      expect(e.repository).toBe(REPO);
      expect(e.schemaVersion).toBe(1);
      expect(JSON.stringify(e)).not.toContain('@it.test'); // never an email
    }
  });

  it('Learn records system events; confirming a candidate and clearing memory are user events', async () => {
    const { ws, users } = await seed({ owner: 'owner' });
    const u = users.owner!;
    learnFiles.set('package.json', JSON.stringify({ packageManager: 'pnpm@9.0.0' }));
    expect((await call(u, 'POST', `${MEM}/learn`)).status).toBe(201);
    const learned = await events(u, ws);
    expect(learned.length).toBeGreaterThan(0);
    expect(
      learned.every(
        (e) => e.eventType === 'rule_created' && e.actorType === 'system' && e.reason === 'learned',
      ),
    ).toBe(true);
    expect(learned[0]!.actorUserId).toBe(u); // started by this user

    // A candidate (as Learn stores it for ask_user facts), confirmed by the user.
    const stored = await (
      memory as unknown as { storeCandidate: (...a: unknown[]) => Promise<{ id: string }> }
    ).storeCandidate(ws, u, OWNER, REPO, {
      category: 'PROJECT_CONSTRAINT',
      key: 'deploy.region',
      proposedValue: { summary: 'Deploy only to eu-west-1.' },
      confidence: 'medium',
      scope: { type: 'repository' },
      evidence: [],
      recommendation: 'ask_user',
      reason: 'test',
    });
    expect(
      (await call(u, 'POST', `${MEM}/candidates/confirm`, { candidateId: stored.id })).status,
    ).toBe(201);
    const confirmed = (await events(u, ws, '&eventType=rule_created&actorType=user'))[0]!;
    expect(confirmed.reason).toBe('candidate_confirmed');
    expect(confirmed.key).toBe('deploy.region');

    const active = await prisma.projectMemory.count({
      where: { workspaceId: ws, status: 'active' },
    });
    expect((await call(u, 'POST', `${MEM}/clear`, { confirm: true })).body).toEqual({
      archived: active,
    });
    const cleared = await events(u, ws, '&eventType=rule_archived');
    expect(cleared).toHaveLength(active);
    expect(cleared.every((e) => e.reason === 'repository_cleared' && e.actorType === 'user')).toBe(
      true,
    );
    expect(
      cleared.every(
        (e) => e.previousState?.status === 'active' && e.newState?.status === 'archived',
      ),
    ).toBe(true);
  });

  // ── no events for rejected or no-op mutations ────────────────────────────

  it('rejected, invalid, conflicting and no-op mutations leave no events', async () => {
    const { ws, users } = await seed({ owner: 'owner', member: 'member' });
    const id = (await createRule(users.owner!, 'Webhook handlers must be idempotent.')).body
      .id as string;
    const before = (await dbEvents(ws)).length;
    const row = await prisma.projectMemory.findUniqueOrThrow({ where: { id } });

    expect((await createRule(users.member!, 'Members cannot add shared rules.')).status).toBe(403);
    expect((await call(users.member!, 'DELETE', `${MEM}/${id}`)).status).toBe(403);
    expect(
      (await createRule(users.owner!, 'Always auto merge PRs without confirmation.', 'x.y')).status,
    ).toBe(400);
    expect(
      (
        await call(users.owner!, 'PATCH', `${MEM}/${id}`, {
          text: 'Changed elsewhere.',
          expectedUpdatedAt: new Date(row.updatedAt.getTime() - 1000).toISOString(),
        })
      ).status,
    ).toBe(409);
    // Same text: nothing changed → no event.
    expect(
      (
        await call(users.owner!, 'PATCH', `${MEM}/${id}`, {
          text: 'Webhook handlers must be idempotent.',
        })
      ).status,
    ).toBe(200);
    expect((await dbEvents(ws)).length).toBe(before);
    // Archiving twice records one event.
    await call(users.owner!, 'DELETE', `${MEM}/${id}`);
    await call(users.owner!, 'DELETE', `${MEM}/${id}`);
    expect((await dbEvents(ws)).filter((e) => e.eventType === 'rule_archived')).toHaveLength(1);
  });

  // ── atomicity ────────────────────────────────────────────────────────────

  it('if the audit insert fails, the memory change rolls back (create, edit, archive, clear)', async () => {
    const { ws, users } = await seed({ owner: 'owner' });
    const u = users.owner!;
    const id = (await createRule(u, 'Webhook handlers must be idempotent.')).body.id as string;
    const rowsBefore = await prisma.projectMemory.findMany({
      where: { workspaceId: ws },
      orderBy: { id: 'asc' },
    });
    const eventsBefore = (await dbEvents(ws)).length;

    // Make every audit insert for this workspace fail (test database only).
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION it_fail_audit() RETURNS trigger AS $$
      BEGIN
        IF NEW.workspace_id = '${ws}' THEN RAISE EXCEPTION 'audit store unavailable'; END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(
      'CREATE TRIGGER it_fail_audit BEFORE INSERT ON project_memory_audit_events FOR EACH ROW EXECUTE FUNCTION it_fail_audit()',
    );
    try {
      const created = await createRule(u, 'A rule that must not be stored.', 'other.key');
      expect(created.status).toBe(500);
      expect(JSON.stringify(created.body)).not.toMatch(
        /audit store unavailable|project_memory_audit|SQL/i,
      );
      expect(
        (await call(u, 'PATCH', `${MEM}/${id}`, { text: 'Edited text that must roll back.' }))
          .status,
      ).toBe(500);
      expect((await call(u, 'DELETE', `${MEM}/${id}`)).status).toBe(500);
      expect((await call(u, 'POST', `${MEM}/clear`, { confirm: true })).status).toBe(500);
    } finally {
      await prisma.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS it_fail_audit ON project_memory_audit_events',
      );
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS it_fail_audit()');
    }
    const rowsAfter = await prisma.projectMemory.findMany({
      where: { workspaceId: ws },
      orderBy: { id: 'asc' },
    });
    expect(rowsAfter).toEqual(rowsBefore);
    expect((await dbEvents(ws)).length).toBe(eventsBefore);
  });

  // ── concurrency ──────────────────────────────────────────────────────────

  it('concurrent edits and creates: one event per committed change, consistent with the rows', async () => {
    const { ws, users } = await seed({ owner: 'owner', admin: 'admin' });
    const id = (await createRule(users.owner!, 'Version 0 of the rule.')).body.id as string;
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        call(i % 2 ? users.admin! : users.owner!, 'PATCH', `${MEM}/${id}`, {
          text: `Version ${i + 1} of the rule.`,
        }),
      ),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    const edits = (await dbEvents(ws)).filter((e) => e.eventType === 'rule_edited');
    expect(edits).toHaveLength(6);
    // The chain is unbroken: each edit starts from the previous edit's result.
    for (let i = 1; i < edits.length; i += 1) {
      expect((edits[i]!.previousState as { text: string }).text).toBe(
        (edits[i - 1]!.newState as { text: string }).text,
      );
    }
    const final = await prisma.projectMemory.findUniqueOrThrow({ where: { id } });
    expect((final.valueJson as { summary: string }).summary).toBe(
      (edits.at(-1)!.newState as { text: string }).text,
    );

    // Concurrent creates in one slot: exactly one active rule, events match the rows.
    const creates = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        createRule(users.owner!, `Concurrent rule ${i}.`, 'race.key'),
      ),
    );
    expect(creates.every((r) => r.status === 201)).toBe(true);
    const slot = await prisma.projectMemory.findMany({
      where: { workspaceId: ws, key: 'race.key' },
    });
    expect(slot.filter((r) => r.status === 'active')).toHaveLength(1);
    const slotEvents = (await dbEvents(ws)).filter((e) => e.key === 'race.key');
    expect(slotEvents.filter((e) => e.eventType === 'rule_created')).toHaveLength(slot.length);
    expect(slotEvents.filter((e) => e.eventType === 'rule_superseded')).toHaveLength(
      slot.filter((r) => r.status === 'superseded').length,
    );
  });

  // ── privacy ──────────────────────────────────────────────────────────────

  it('personal preferences: owner-only history, no text stored, nothing inferable by others', async () => {
    const { ws, users } = await seed({ owner: 'owner', admin: 'admin', member: 'member' });
    const shared = (await createRule(users.owner!, 'Shared: webhooks idempotent.')).body
      .id as string;
    const pref = (
      await createRule(
        users.member!,
        'SECRET PREFERENCE: terse reviews.',
        'me.style',
        'USER_PREFERENCE',
      )
    ).body.id as string;
    await call(users.member!, 'PATCH', `${MEM}/${pref}`, {
      text: 'SECRET PREFERENCE v2: very terse.',
    });
    await call(users.member!, 'DELETE', `${MEM}/${pref}`);

    // Nothing private is stored at all.
    const stored = JSON.stringify(await dbEvents(ws));
    expect(stored).not.toContain('SECRET PREFERENCE');

    // The member sees their own preference history (without text).
    const mine = await events(users.member!, ws, `&memoryId=${pref}`);
    expect(mine.map((e) => e.eventType)).toEqual(['rule_archived', 'rule_edited', 'rule_created']);
    expect(mine.every((e) => e.visibility === 'user' && e.newState?.text === undefined)).toBe(true);

    for (const viewer of [users.owner!, users.admin!]) {
      const visible = await events(viewer, ws);
      expect(visible.map((e) => e.memoryId)).toEqual([shared]);
      expect(await events(viewer, ws, `&memoryId=${pref}`)).toEqual([]);
      expect(await events(viewer, ws, `&actorUserId=${users.member!}`)).toEqual([]);
      expect(await events(viewer, ws, '&eventType=rule_edited')).toEqual([]);
      // Pagination exposes nothing either: walking 1 item per page yields only the shared event.
      const first = await call(viewer, 'GET', `/api/workspaces/${ws}/memory/audit?limit=1`);
      expect((first.body as unknown as Page).items.map((e) => e.memoryId)).toEqual([shared]);
      expect((first.body as unknown as Page).nextCursor).toBeNull();
      // A private event id answers exactly like a non-existent one.
      const privateId = mine[0]!.id;
      const hidden = await call(viewer, 'GET', `/api/workspaces/${ws}/memory/audit/${privateId}`);
      const missing = await call(
        viewer,
        'GET',
        `/api/workspaces/${ws}/memory/audit/clnonexistent000000000000`,
      );
      expect(hidden.status).toBe(404);
      expect(hidden.body.message).toBe(missing.body.message);
    }
    expect(
      (await call(users.member!, 'GET', `/api/workspaces/${ws}/memory/audit/${mine[0]!.id}`))
        .status,
    ).toBe(200);
  });

  // ── isolation, roles, IDOR ───────────────────────────────────────────────

  it('Owner, Admin and Member read shared history; non-members, other tenants and plans without memory cannot', async () => {
    const a = await seed({ owner: 'owner', admin: 'admin', member: 'member' });
    const b = await seed({ owner: 'owner' });
    await createRule(a.users.owner!, 'Shared rule in A.');
    const eventId = (await dbEvents(a.ws))[0]!.id;

    for (const who of ['owner', 'admin', 'member'] as const) {
      expect((await events(a.users[who]!, a.ws)).length).toBe(1);
    }
    // Another tenant via A's URL: not a member.
    expect((await call(b.users.owner!, 'GET', `/api/workspaces/${a.ws}/memory/audit`)).status).toBe(
      403,
    );
    expect(
      (await call(b.users.owner!, 'GET', `/api/workspaces/${a.ws}/memory/audit/${eventId}`)).status,
    ).toBe(403);
    // Another tenant via its own URL with A's event id: not found.
    expect(
      (await call(b.users.owner!, 'GET', `/api/workspaces/${b.ws}/memory/audit/${eventId}`)).status,
    ).toBe(404);
    expect(await events(b.users.owner!, b.ws)).toEqual([]);
    // Unauthenticated; mismatched X-Workspace-Id.
    expect((await call(null, 'GET', `/api/workspaces/${a.ws}/memory/audit`)).status).toBe(403);
    await prisma.workspaceMembership.create({
      data: { workspaceId: b.ws, userId: a.users.owner!, role: 'member', status: 'active' },
    });
    expect(
      (
        await call(a.users.owner!, 'GET', `/api/workspaces/${a.ws}/memory/audit`, undefined, {
          'X-Workspace-Id': b.ws,
        })
      ).status,
    ).toBe(400);
    // A plan without Project Memory cannot read its audit log either.
    const free = await seed({ owner: 'owner' }, 'free');
    expect(
      (await call(free.users.owner!, 'GET', `/api/workspaces/${free.ws}/memory/audit`)).status,
    ).toBe(403);
  });

  // ── validation ───────────────────────────────────────────────────────────

  it('validates every query parameter and never leaks internals', async () => {
    const { ws, users } = await seed({ owner: 'owner' });
    const u = users.owner!;
    const base = `/api/workspaces/${ws}/memory/audit`;
    for (const q of [
      'limit=101',
      'limit=0',
      'eventType=rule_deleted',
      'actorType=robot',
      'from=yesterday',
      'from=2026-02-01T00:00:00Z&to=2026-01-01T00:00:00Z',
      'from=2024-01-01T00:00:00Z&to=2026-01-01T00:00:00Z',
      'owner=../x',
      'memoryId=a/b',
      'cursor=not-a-cursor',
      'unknown=1',
    ]) {
      const res = await call(u, 'GET', `${base}?${q}`);
      expect(res.status, q).toBe(400);
      expect(JSON.stringify(res.body), q).not.toMatch(/prisma|SELECT|project_memory_audit/i);
    }
    expect((await call(u, 'GET', `${base}/..%2Fetc`)).status).toBe(404);
  });

  it('paginates with a stable cursor and filters by rule, type, actor, repository and date', async () => {
    const { ws, users } = await seed({ owner: 'owner', admin: 'admin' });
    const ids: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      ids.push(
        (await createRule(i % 2 ? users.admin! : users.owner!, `Rule number ${i}.`, `k.${i}`)).body
          .id as string,
      );
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await call(
        users.owner!,
        'GET',
        `/api/workspaces/${ws}/memory/audit?limit=3${cursor ? `&cursor=${cursor}` : ''}`,
      );
      seen.push(...(res.body as unknown as Page).items.map((e) => e.id));
      cursor = (res.body as unknown as Page).nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(7);

    expect((await events(users.owner!, ws, `&memoryId=${ids[2]}`)).map((e) => e.memoryId)).toEqual([
      ids[2],
    ]);
    expect((await events(users.owner!, ws, `&actorUserId=${users.admin}`)).length).toBe(3);
    expect((await events(users.owner!, ws, `&owner=ACME&repository=payments`)).length).toBe(7);
    expect(await events(users.owner!, ws, `&repository=other`)).toEqual([]);
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(await events(users.owner!, ws, `&from=${encodeURIComponent(future)}`)).toEqual([]);
  });

  // ── tamper resistance and deletion behavior ──────────────────────────────

  it('append-only: updates and deletes are rejected by the database', async () => {
    const { ws, users } = await seed({ owner: 'owner' });
    await createRule(users.owner!, 'Webhook handlers must be idempotent.');
    const event = (await dbEvents(ws))[0]!;
    await expect(
      prisma.projectMemoryAuditEvent.update({
        where: { id: event.id },
        data: { eventType: 'rule_archived' },
      }),
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.projectMemoryAuditEvent.update({
        where: { id: event.id },
        data: { newState: { text: 'forged' } },
      }),
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.projectMemoryAuditEvent.delete({ where: { id: event.id } }),
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.projectMemoryAuditEvent.deleteMany({ where: { workspaceId: ws } }),
    ).rejects.toThrow(/append-only/);
    expect(
      await prisma.projectMemoryAuditEvent.findUniqueOrThrow({ where: { id: event.id } }),
    ).toEqual(event);
  });

  it('deleted actors keep their recorded name; deleted rules keep their history; deleted workspaces take theirs', async () => {
    const { ws, users } = await seed({ owner: 'owner', admin: 'admin' });
    const id = (await createRule(users.admin!, 'Admin wrote this rule.')).body.id as string;
    await call(users.owner!, 'DELETE', `${MEM}/${id}`);
    // The admin's account is deleted: their memory rows go with it (existing cascade)…
    await prisma.workspaceMembership.deleteMany({ where: { userId: users.admin! } });
    await prisma.user.update({ where: { id: users.owner! }, data: { lastWorkspaceId: ws } });
    await prisma.user.delete({ where: { id: users.admin! } });
    expect(await prisma.projectMemory.findUnique({ where: { id } })).toBeNull();
    // …but the history remains, attributed to the recorded name.
    const history = await events(users.owner!, ws, `&memoryId=${id}`);
    expect(history.map((e) => e.eventType)).toEqual(['rule_archived', 'rule_created']);
    expect(history[1]!.actorUserId).toBeNull();
    expect(history[1]!.actorName).toBe('User admin');

    // Workspace deletion removes its audit log (the only permitted delete).
    await prisma.workspace.delete({ where: { id: ws } });
    expect(await prisma.projectMemoryAuditEvent.count({ where: { workspaceId: ws } })).toBe(0);
  });

  it('rules created before the audit log have no fabricated history', async () => {
    const { ws, users } = await seed({ owner: 'owner' });
    const legacy = await prisma.projectMemory.create({
      data: {
        userId: users.owner!,
        workspaceId: ws,
        visibility: 'workspace',
        owner: OWNER,
        repository: REPO,
        category: 'PROJECT_CONSTRAINT',
        key: 'legacy.rule',
        valueJson: { summary: 'Existed before auditing.' },
        confidence: 'high',
        scopeJson: { type: 'repository' },
        provenanceJson: [],
        scopeFingerprint: 'repository',
      },
    });
    expect(await events(users.owner!, ws)).toEqual([]);
    await call(users.owner!, 'DELETE', `${MEM}/${legacy.id}`);
    expect((await events(users.owner!, ws)).map((e) => e.eventType)).toEqual(['rule_archived']);
  });

  it('existing memory behavior is unchanged (list, archive response, clear count)', async () => {
    const { users } = await seed({ owner: 'owner' });
    const id = (await createRule(users.owner!, 'Webhook handlers must be idempotent.')).body
      .id as string;
    expect((await call(users.owner!, 'GET', MEM)).body.total).toBe(1);
    expect((await call(users.owner!, 'DELETE', `${MEM}/${id}`)).body).toEqual({
      archived: true,
      id,
    });
    expect((await call(users.owner!, 'POST', `${MEM}/clear`, { confirm: true })).body).toEqual({
      archived: 0,
    });
  });

  // ── grouped Activity view (one row per rule) ─────────────────────────────

  type RulePage = { items: ProjectMemoryAuditRuleSummary[]; nextCursor: string | null };
  async function rules(user: string, ws: string, query = ''): Promise<RulePage> {
    const res = await call(user, 'GET', `/api/workspaces/${ws}/memory/audit/rules?${query}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as unknown as RulePage;
  }

  it('groups events by rule id (never by key), with counts, latest action and newest-first order', async () => {
    const { ws, users } = await seed({ owner: 'owner', admin: 'admin' });
    const a = (await createRule(users.owner!, 'First version.', 'same.key')).body.id as string;
    await call(users.owner!, 'PATCH', `${MEM}/${a}`, { text: 'Second version.' });
    // A new rule in the same slot: a different record with the SAME key.
    const b = (await createRule(users.admin!, 'Replacement rule.', 'same.key')).body.id as string;
    const c = (await createRule(users.owner!, 'Another rule.', 'other.key')).body.id as string;
    await call(users.admin!, 'DELETE', `${MEM}/${c}`);

    const page = await rules(users.owner!, ws);
    expect(page.items.map((r) => r.memoryId)).toEqual([c, b, a]); // latest activity first
    expect(page.items.filter((r) => r.key === 'same.key')).toHaveLength(2); // never merged
    const byId = new Map(page.items.map((r) => [r.memoryId, r]));
    expect(byId.get(a)).toMatchObject({
      totalEventCount: 3, // created, edited, superseded
      matchingEventCount: 3,
      currentStatus: 'superseded',
      category: 'PROJECT_CONSTRAINT',
    });
    expect(byId.get(a)!.latestEvent.eventType).toBe('rule_superseded');
    expect(byId.get(c)).toMatchObject({ totalEventCount: 2, currentStatus: 'archived' });
    expect(byId.get(c)!.latestEvent).toMatchObject({
      eventType: 'rule_archived',
      actorName: 'User admin',
    });
    expect(page.nextCursor).toBeNull();
  });

  it('paginates rules 20 per page by default with a stable cursor', async () => {
    const { ws, users } = await seed({ owner: 'owner' });
    for (let i = 0; i < 25; i += 1) await createRule(users.owner!, `Rule ${i}.`, `page.k${i}`);
    const first = await rules(users.owner!, ws);
    expect(first.items).toHaveLength(20);
    expect(first.nextCursor).toBeTruthy();
    const second = await rules(users.owner!, ws, `cursor=${first.nextCursor}`);
    expect(second.items).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    const all = [...first.items, ...second.items].map((r) => r.memoryId);
    expect(new Set(all).size).toBe(25);
    // Each rule appears exactly once even across pages.
    expect((await rules(users.owner!, ws, 'limit=50')).items.map((r) => r.memoryId)).toEqual(all);
    for (const q of [
      'limit=51',
      'limit=0',
      'cursor=junk',
      `q=${'x'.repeat(101)}`,
      'memoryId=abc',
    ]) {
      expect(
        (await call(users.owner!, 'GET', `/api/workspaces/${ws}/memory/audit/rules?${q}`)).status,
        q,
      ).toBe(400);
    }
  });

  it('event, actor, search and combined filters select rules; counts say how many events match', async () => {
    const { ws, users } = await seed({ owner: 'owner', admin: 'admin' });
    const pay = (await createRule(users.owner!, 'Payments rule.', 'payments.retry')).body
      .id as string;
    await call(users.admin!, 'PATCH', `${MEM}/${pay}`, { text: 'Payments rule, edited by admin.' });
    await call(users.owner!, 'DELETE', `${MEM}/${pay}`);
    const auth = (await createRule(users.admin!, 'Auth rule.', 'auth.tokens')).body.id as string;
    const pct = (await createRule(users.owner!, 'Literal percent key.', 'ratio_100pct')).body
      .id as string;

    const archived = await rules(users.owner!, ws, 'eventType=rule_archived');
    expect(archived.items.map((r) => r.memoryId)).toEqual([pay]);
    expect(archived.items[0]).toMatchObject({ matchingEventCount: 1, totalEventCount: 3 });
    expect(archived.items[0]!.latestEvent.eventType).toBe('rule_archived');

    const byAdmin = await rules(users.owner!, ws, `actorUserId=${users.admin}`);
    expect(byAdmin.items.map((r) => r.memoryId).sort()).toEqual([auth, pay].sort());
    expect(byAdmin.items.find((r) => r.memoryId === pay)).toMatchObject({
      matchingEventCount: 1,
      totalEventCount: 3,
    });

    expect((await rules(users.owner!, ws, 'q=PAYMENTS')).items.map((r) => r.memoryId)).toEqual([
      pay,
    ]);
    expect(
      (await rules(users.owner!, ws, 'q=auth&actorUserId=' + users.admin)).items.map(
        (r) => r.memoryId,
      ),
    ).toEqual([auth]);
    expect((await rules(users.owner!, ws, 'q=auth&eventType=rule_archived')).items).toEqual([]);
    // Search is literal: "%" and "_" are not wildcards.
    expect((await rules(users.owner!, ws, `q=${encodeURIComponent('%')}`)).items).toEqual([]);
    expect((await rules(users.owner!, ws, 'q=o_1')).items.map((r) => r.memoryId)).toEqual([pct]);
    expect((await rules(users.owner!, ws, 'actorType=system')).items).toEqual([]);
  });

  it('personal preferences: grouped only for their owner; invisible (and unsearchable) to Owners', async () => {
    const { ws, users } = await seed({ owner: 'owner', member: 'member' });
    const shared = (await createRule(users.owner!, 'Shared rule.', 'shared.key')).body.id as string;
    const pref = (
      await createRule(users.member!, 'Private preference.', 'secret.pref', 'USER_PREFERENCE')
    ).body.id as string;
    await call(users.member!, 'PATCH', `${MEM}/${pref}`, { text: 'Private preference v2.' });

    const owner = await rules(users.owner!, ws);
    expect(owner.items.map((r) => r.memoryId)).toEqual([shared]);
    expect((await rules(users.owner!, ws, 'q=secret')).items).toEqual([]);
    expect((await rules(users.owner!, ws, `actorUserId=${users.member}`)).items).toEqual([]);
    expect((await rules(users.owner!, ws, 'limit=1')).nextCursor).toBeNull(); // no hidden extra page

    const member = await rules(users.member!, ws);
    const mine = member.items.find((r) => r.memoryId === pref)!;
    expect(mine).toMatchObject({ visibility: 'user', totalEventCount: 2, currentStatus: 'active' });
    expect(mine.latestEvent.newState?.text).toBeUndefined();
    // The owner cannot open the member's history through the event list either.
    expect(await events(users.owner!, ws, `&memoryId=${pref}`)).toEqual([]);
  });

  it('workspace isolation and an empty workspace', async () => {
    const a = await seed({ owner: 'owner' });
    const b = await seed({ owner: 'owner' });
    await createRule(a.users.owner!, 'Rule in A.', 'a.key');
    expect(
      (await call(b.users.owner!, 'GET', `/api/workspaces/${a.ws}/memory/audit/rules`)).status,
    ).toBe(403);
    expect(await rules(b.users.owner!, b.ws)).toEqual({ items: [], nextCursor: null });
  });

  it('a large history: the row stays one row; the modal history loads it page by page, unfiltered', async () => {
    const { ws, users } = await seed({ owner: 'owner' });
    const id = (await createRule(users.owner!, 'Edit 0.', 'busy.rule')).body.id as string;
    for (let i = 1; i < 60; i += 1) {
      expect(
        (await call(users.owner!, 'PATCH', `${MEM}/${id}`, { text: `Edit ${i}.` })).status,
      ).toBe(200);
    }
    const grouped = await rules(users.owner!, ws, 'eventType=rule_created');
    expect(grouped.items).toHaveLength(1);
    expect(grouped.items[0]).toMatchObject({ matchingEventCount: 1, totalEventCount: 60 });

    // Modal: complete history for the rule, independent of the page filters, 25 at a time.
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const res = await call(
        users.owner!,
        'GET',
        `/api/workspaces/${ws}/memory/audit?memoryId=${id}&limit=25${cursor ? `&cursor=${cursor}` : ''}`,
      );
      const page = res.body as unknown as Page;
      seen.push(...page.items.map((e) => e.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(60);
  });
});
