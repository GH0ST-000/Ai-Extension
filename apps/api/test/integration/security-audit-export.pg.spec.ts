/**
 * F-29 — the security audit export reads the durable table, so it does not depend on which
 * API instance recorded an event or on that instance still being alive. Real PostgreSQL;
 * two SecurityAuditService objects stand for two API instances (each with its own memory).
 */
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RequestContextService } from '../../src/observability/request-context.service';
import { SecurityAuditService } from '../../src/observability/security-audit.service';

const URL_ENV = process.env.MEMORY_IT_DATABASE_URL;

describe.skipIf(!URL_ENV)('Security audit export (PostgreSQL)', () => {
  let prisma: PrismaClient;
  const config = {
    get: (key: string) =>
      key === 'service'
        ? 'api'
        : key === 'release'
          ? 'it-release'
          : key === 'nodeEnv'
            ? 'test'
            : undefined,
  };
  const instance = () =>
    new SecurityAuditService(config as never, new RequestContextService(), prisma as never);
  const workspaceId = `ws_audit_${Date.now()}`;

  beforeAll(async () => {
    const url = new URL(URL_ENV!);
    if (!url.pathname.endsWith('_it') || url.port === '5432') {
      throw new Error(`Refusing to run integration tests against ${url.host}${url.pathname}`);
    }
    prisma = new PrismaClient({ datasourceUrl: URL_ENV });
    await prisma.$connect();
  });
  afterAll(async () => prisma?.$disconnect());

  async function untilPersisted(count: number) {
    for (let i = 0; i < 500; i += 1) {
      if ((await prisma.securityAuditEventRecord.count({ where: { workspaceId } })) >= count)
        return;
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error('audit events were not persisted');
  }
  const mine = (ndjson: string) =>
    ndjson
      .split('\n')
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            workspaceId?: string;
            type: string;
            detail?: string;
            timestamp: string;
          },
      )
      .filter((event) => event.workspaceId === workspaceId);

  it('an event recorded by one instance is exported by another, and after a "restart"', async () => {
    const a = instance();
    a.record({ type: 'workspace.member.removed', outcome: 'success', workspaceId, detail: 'n=1' });
    a.record({
      type: 'github.write.denied',
      outcome: 'blocked',
      workspaceId,
      detail: 'n=2',
      ip: '203.0.113.7',
    });
    await untilPersisted(2);

    // A different instance (empty memory) — and instance A's memory is gone.
    const b = instance();
    expect(b.exportNdjson({ limit: 100 })).toBe(''); // its own memory has nothing
    const exported = mine(await b.exportPersistedNdjson({ limit: 1000 }));
    expect(exported.map((e) => e.detail)).toEqual(['n=1', 'n=2']); // oldest first
    // Safe metadata only: no client address is stored or exported.
    expect(JSON.stringify(exported)).not.toContain('203.0.113.7');
  });

  it('`since` pages forward from the oldest matching event; `limit` is honoured', async () => {
    const svc = instance();
    const first = mine(await svc.exportPersistedNdjson({ limit: 1000 }))[0]!;
    const page = mine(
      await svc.exportPersistedNdjson({ since: new Date(first.timestamp), limit: 1000 }),
    );
    expect(page.length).toBe(2);
    const none = await svc.exportPersistedNdjson({
      since: new Date(Date.now() + 60_000),
      limit: 10,
    });
    expect(none).toBe('');
    const one = (await svc.exportPersistedNdjson({ limit: 1 })).split('\n').filter(Boolean);
    expect(one).toHaveLength(1);
  });

  it('cursor paging over events that share one timestamp neither loops nor skips', async () => {
    const at = new Date(Date.now() - 86_400_000 * 400); // far from every other test's rows
    const ws = `${workspaceId}_same_ms`;
    const ids = ['a', 'b', 'c', 'd', 'e'].map((suffix) => `sec_cursor_${Date.now()}_${suffix}`);
    await prisma.securityAuditEventRecord.createMany({
      data: ids.map((id) => ({
        id,
        type: 'auth.logout',
        outcome: 'success',
        workspaceId: ws,
        service: 'api',
        release: 'it',
        environment: 'test',
        createdAt: at,
      })),
    });
    const svc = instance();
    const seen: string[] = [];
    let afterId: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const lines = (
        await svc.exportPersistedNdjson({ since: at, limit: 2, ...(afterId ? { afterId } : {}) })
      )
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { id: string; workspaceId?: string; timestamp: string })
        .filter((event) => event.timestamp === at.toISOString());
      if (lines.length === 0) break;
      seen.push(...lines.filter((event) => event.workspaceId === ws).map((event) => event.id));
      afterId = lines.at(-1)!.id;
    }
    expect(seen).toEqual([...ids].sort());
  });

  it("falls back to this instance's memory when the database cannot be read", async () => {
    const broken = new SecurityAuditService(config as never, new RequestContextService(), {
      securityAuditEventRecord: {
        create: async () => ({}),
        findMany: async () => {
          throw new Error('db down');
        },
      },
    } as never);
    broken.record({ type: 'auth.logout', outcome: 'success', workspaceId });
    expect(mine(await broken.exportPersistedNdjson({ limit: 10 }))).toHaveLength(1);
  });
});
