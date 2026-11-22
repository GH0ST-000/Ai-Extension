/**
 * Project Memory — database-level active-slot uniqueness (migration
 * 20261115090000_project_memory_active_slot_unique).
 *
 * Proves PostgreSQL itself rejects a second ACTIVE rule in a slot, for writes that bypass
 * ProjectMemoryService (Prisma client and raw SQL), and that the migration resolves existing
 * duplicates by superseding (never deleting) them with an audit record.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL_ENV = process.env.MEMORY_IT_DATABASE_URL;
const MIGRATION = join(
  __dirname,
  '../../prisma/migrations/20261115090000_project_memory_active_slot_unique/migration.sql',
);
const INDEXES = [
  'project_memory_active_workspace_slot_uidx',
  'project_memory_active_personal_slot_uidx',
  'project_memory_active_legacy_slot_uidx',
];

/** PostgreSQL unique_violation as surfaced by Prisma raw queries. */
const UNIQUE_VIOLATION = /Code: `23505`/;

type Row = {
  id: string;
  userId: string;
  workspaceId?: string | null;
  visibility?: 'workspace' | 'user';
  owner?: string;
  repository?: string;
  category?: string;
  key?: string;
  status?: string;
  scopeFingerprint?: string;
  explicit?: boolean;
  summary?: string;
  updatedAt?: string;
};

describe.skipIf(!URL_ENV)('Project Memory active-slot unique indexes (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let run = 0;

  beforeAll(async () => {
    const url = new URL(URL_ENV!);
    if (!url.pathname.endsWith('_it') || url.port === '5432') {
      throw new Error(`Refusing to run integration tests against ${url.host}${url.pathname}`);
    }
    prisma = new PrismaClient({ datasourceUrl: URL_ENV });
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function seed(userCount = 2) {
    run += 1;
    const tag = `${Date.now().toString(36)}_${run}`;
    const ws = `ws_uidx_${tag}`;
    const ws2 = `ws_uidx2_${tag}`;
    for (const id of [ws, ws2]) {
      await prisma.workspace.create({ data: { id, name: id, slug: id } });
    }
    const users: string[] = [];
    for (let i = 0; i < userCount; i += 1) {
      const id = `uidx_u${i}_${tag}`;
      await prisma.user.create({ data: { id, email: `${id}@it.test`, passwordHash: 'x' } });
      users.push(id);
    }
    return { ws, ws2, users, tag };
  }

  function data(r: Row) {
    return {
      id: r.id,
      userId: r.userId,
      workspaceId: r.workspaceId === undefined ? null : r.workspaceId,
      createdByUserId: r.userId,
      visibility: r.visibility ?? 'workspace',
      owner: r.owner ?? 'acme',
      repository: r.repository ?? 'payments',
      category: r.category ?? 'PROJECT_CONSTRAINT',
      key: r.key ?? 'pay.wh',
      valueJson: { summary: r.summary ?? 'Webhook handlers must be idempotent.' },
      confidence: 'high',
      status: r.status ?? 'active',
      scopeJson: { type: 'repository' },
      provenanceJson: [
        { type: r.explicit ? 'user_explicit' : 'repository_observation', observedAt: 'x' },
      ],
      scopeFingerprint: r.scopeFingerprint ?? 'repository',
    };
  }

  const create = (r: Row) => prisma.projectMemory.create({ data: data(r) });

  // ── the indexes exist with the intended predicates ──────────────────────

  it('migration created the three partial unique indexes', async () => {
    const rows = await prisma.$queryRaw<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = current_schema() AND tablename = 'project_memories'
        AND indexname LIKE 'project_memory_active_%'`;
    const byName = Object.fromEntries(rows.map((r) => [r.indexname, r.indexdef]));
    for (const name of INDEXES) {
      expect(byName[name]).toMatch(/^CREATE UNIQUE INDEX/);
      expect(byName[name]).toMatch(/WHERE .*status = 'active'/);
    }
  });

  // ── writes that bypass the service are rejected ─────────────────────────

  it('a second active shared rule in the same workspace slot is rejected (Prisma, any author)', async () => {
    const { ws, users } = await seed();
    await create({ id: `a_${run}`, userId: users[0]!, workspaceId: ws });
    await expect(
      create({ id: `b_${run}`, userId: users[1]!, workspaceId: ws, summary: 'Other text' }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('raw SQL inserts and reactivating UPDATEs are rejected too', async () => {
    const { ws, users } = await seed();
    await create({ id: `a_${run}`, userId: users[0]!, workspaceId: ws });
    const archivedId = `arch_${run}`;
    await create({ id: archivedId, userId: users[0]!, workspaceId: ws, status: 'archived' });

    await expect(
      prisma.$executeRaw`
        INSERT INTO project_memories (id, user_id, workspace_id, visibility, provider, owner,
          repository, category, key, value_json, confidence, status, scope_json,
          provenance_json, scope_fingerprint, updated_at)
        VALUES (${`raw_${run}`}, ${users[1]!}, ${ws}, 'workspace', 'github', 'acme', 'payments',
          'PROJECT_CONSTRAINT', 'pay.wh', '{"summary":"raw"}'::jsonb, 'high', 'active',
          '{"type":"repository"}'::jsonb, '[]'::jsonb, 'repository', now())`,
    ).rejects.toThrow(UNIQUE_VIOLATION);

    await expect(
      prisma.$executeRaw`UPDATE project_memories SET status = 'active' WHERE id = ${archivedId}`,
    ).rejects.toThrow(UNIQUE_VIOLATION);
    await expect(
      prisma.projectMemory.update({ where: { id: archivedId }, data: { status: 'active' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    expect((await prisma.projectMemory.findUnique({ where: { id: archivedId } }))!.status).toBe(
      'archived',
    );
  });

  it('personal and legacy slots are unique per author', async () => {
    const { ws, users } = await seed();
    const pref = {
      userId: users[0]!,
      workspaceId: ws,
      visibility: 'user' as const,
      category: 'USER_PREFERENCE',
      key: 'tone',
    };
    await create({ id: `p1_${run}`, ...pref });
    await expect(create({ id: `p2_${run}`, ...pref })).rejects.toMatchObject({ code: 'P2002' });

    const legacy = { userId: users[0]!, workspaceId: null };
    await create({ id: `l1_${run}`, ...legacy });
    await expect(create({ id: `l2_${run}`, ...legacy })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('distinct slots and non-active rows are not constrained', async () => {
    const { ws, ws2, users } = await seed(2);
    const [u0, u1] = users as [string, string];
    const rows: Row[] = [
      { id: `s1_${run}`, userId: u0, workspaceId: ws },
      { id: `s2_${run}`, userId: u0, workspaceId: ws2 }, // other workspace
      { id: `s3_${run}`, userId: u0, workspaceId: ws, repository: 'ledger' }, // other repo
      { id: `s4_${run}`, userId: u0, workspaceId: ws, key: 'pay.other' }, // other key
      { id: `s5_${run}`, userId: u0, workspaceId: ws, category: 'CODE_CONVENTION' },
      { id: `s6_${run}`, userId: u0, workspaceId: ws, scopeFingerprint: 'directory:apps/api' },
      { id: `s7_${run}`, userId: u0, workspaceId: ws, status: 'superseded' },
      { id: `s8_${run}`, userId: u0, workspaceId: ws, status: 'archived' },
      { id: `s9_${run}`, userId: u0, workspaceId: ws, status: 'disputed' },
      { id: `s10_${run}`, userId: u0, workspaceId: ws, status: 'superseded' },
      // Personal preferences of two users with the same key, plus the shared rule's slot.
      { id: `s11_${run}`, userId: u0, workspaceId: ws, visibility: 'user' },
      { id: `s12_${run}`, userId: u1, workspaceId: ws, visibility: 'user' },
      // Legacy rows of two users, and alongside a workspace row.
      { id: `s13_${run}`, userId: u0, workspaceId: null },
      { id: `s14_${run}`, userId: u1, workspaceId: null },
    ];
    for (const r of rows) await create(r);
    expect(await prisma.projectMemory.count({ where: { id: { in: rows.map((r) => r.id) } } })).toBe(
      rows.length,
    );
  });

  // ── the migration's duplicate resolution ────────────────────────────────

  describe('existing duplicates are resolved without data loss', () => {
    const schema = `uidx_dedup_${process.pid}`;

    beforeAll(async () => {
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      // Same columns and defaults as production, but no indexes / FKs: the pre-migration shape.
      await prisma.$executeRawUnsafe(
        `CREATE TABLE "${schema}".project_memories (LIKE public.project_memories INCLUDING DEFAULTS)`,
      );
    });

    afterAll(async () => {
      await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    });

    async function insert(r: Row) {
      const d = data(r);
      await prisma.$executeRawUnsafe(
        `INSERT INTO "${schema}".project_memories (id, user_id, workspace_id, created_by_user_id,
           visibility, provider, owner, repository, category, key, value_json, confidence, status,
           scope_json, provenance_json, scope_fingerprint, updated_at)
         VALUES ($1,$2,$3,$4,$5,'github',$6,$7,$8,$9,$10::jsonb,$11,$12,$13::jsonb,$14::jsonb,$15,$16::timestamp)`,
        d.id,
        d.userId,
        d.workspaceId,
        d.createdByUserId,
        d.visibility,
        d.owner,
        d.repository,
        d.category,
        d.key,
        JSON.stringify(d.valueJson),
        d.confidence,
        d.status,
        JSON.stringify(d.scopeJson),
        JSON.stringify(d.provenanceJson),
        d.scopeFingerprint,
        r.updatedAt ?? '2026-11-01T00:00:00Z',
      );
    }

    /**
     * The migration file, applied to the scratch schema in-process. Previously each run spawned
     * `npx prisma db execute` (Node + Prisma CLI boot): measured 1.3–2.9 s per spawn, ~4.2 s of
     * this test's ~4.3 s, which pushed it past the 5 s limit when 27 suites ran in parallel.
     * Same SQL, executed statement by statement in one transaction (LOCK TABLE needs one) with
     * the search_path set to the scratch schema, as `db execute --url …?schema=` does.
     */
    const statements = readFileSync(MIGRATION, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*--/.test(line))
      .join('\n')
      .split(/;\s*(?:\n|$)/)
      .map((statement) => statement.trim())
      .filter(Boolean);
    const applyMigration = () =>
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL search_path TO "${schema}"`);
        for (const statement of statements) await tx.$executeRawUnsafe(statement);
      });

    const snapshot = () =>
      prisma.$queryRawUnsafe<{ id: string; status: string; value_json: unknown }[]>(
        `SELECT id, status, value_json FROM "${schema}".project_memories ORDER BY id`,
      );
    const audit = () =>
      prisma.$queryRawUnsafe<
        { memory_id: string; kept_memory_id: string; previous_status: string; reason: string }[]
      >(
        `SELECT memory_id, kept_memory_id, previous_status, reason
         FROM "${schema}".project_memory_dedup_audit ORDER BY memory_id`,
      );

    it('the migration file splits into its 8 statements (nothing skipped)', () => {
      expect(statements).toHaveLength(8);
      expect(statements[0]).toMatch(/^LOCK TABLE/);
      expect(statements.filter((st) => /^CREATE UNIQUE INDEX/.test(st))).toHaveLength(3);
    });

    it('keeps the explicit / newest rule per slot, supersedes the rest, audits, is idempotent', async () => {
      const W = 'ws_x';
      const rows: Row[] = [
        // Shared slot: explicit (older) beats learned (newer).
        { id: 'w_learned_new', userId: 'u1', workspaceId: W, updatedAt: '2026-11-10T00:00:00Z' },
        {
          id: 'w_explicit_old',
          userId: 'u2',
          workspaceId: W,
          explicit: true,
          updatedAt: '2026-10-01T00:00:00Z',
        },
        { id: 'w_learned_old', userId: 'u1', workspaceId: W, updatedAt: '2026-09-01T00:00:00Z' },
        { id: 'w_archived', userId: 'u1', workspaceId: W, status: 'archived' },
        // Same slot in another workspace: independent.
        { id: 'w2_only', userId: 'u1', workspaceId: 'ws_y' },
        // Personal: same author twice (newest wins), another author independent.
        {
          id: 'p_u1_new',
          userId: 'u1',
          workspaceId: W,
          visibility: 'user',
          updatedAt: '2026-11-05T00:00:00Z',
        },
        {
          id: 'p_u1_old',
          userId: 'u1',
          workspaceId: W,
          visibility: 'user',
          updatedAt: '2026-11-04T00:00:00Z',
        },
        { id: 'p_u2', userId: 'u2', workspaceId: W, visibility: 'user' },
        // Legacy (no workspace): per author.
        { id: 'l_u1_new', userId: 'u1', workspaceId: null, updatedAt: '2026-11-03T00:00:00Z' },
        { id: 'l_u1_old', userId: 'u1', workspaceId: null, updatedAt: '2026-11-02T00:00:00Z' },
        { id: 'l_u2', userId: 'u2', workspaceId: null },
      ];
      for (const r of rows) await insert(r);
      const before = await snapshot();

      await applyMigration();

      const after = await snapshot();
      expect(after).toHaveLength(before.length); // nothing deleted
      // Content is untouched; only status changes.
      expect(after.map((r) => [r.id, r.value_json])).toEqual(
        before.map((r) => [r.id, r.value_json]),
      );
      const status = Object.fromEntries(after.map((r) => [r.id, r.status]));
      expect(status).toEqual({
        w_learned_new: 'superseded',
        w_explicit_old: 'active',
        w_learned_old: 'superseded',
        w_archived: 'archived',
        w2_only: 'active',
        p_u1_new: 'active',
        p_u1_old: 'superseded',
        p_u2: 'active',
        l_u1_new: 'active',
        l_u1_old: 'superseded',
        l_u2: 'active',
      });
      const expectedAudit = [
        { memory_id: 'l_u1_old', kept_memory_id: 'l_u1_new' },
        { memory_id: 'p_u1_old', kept_memory_id: 'p_u1_new' },
        { memory_id: 'w_learned_new', kept_memory_id: 'w_explicit_old' },
        { memory_id: 'w_learned_old', kept_memory_id: 'w_explicit_old' },
      ].map((a) => ({ ...a, previous_status: 'active', reason: 'duplicate_active_slot' }));
      expect(await audit()).toEqual(expectedAudit);

      // Re-running is a no-op, and the constraint is now live in the scratch schema.
      await applyMigration();
      expect(await snapshot()).toEqual(after);
      expect(await audit()).toEqual(expectedAudit);
      await expect(insert({ id: 'w_dup_after', userId: 'u3', workspaceId: W })).rejects.toThrow(
        UNIQUE_VIOLATION,
      );
    });
  });
});
