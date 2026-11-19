/**
 * Reliability Phase 2 — workflow execution safety, against real PostgreSQL.
 * Retry cap from persisted state (also under concurrency), race-safe execution numbering,
 * stale-execution marking, workspace-scoped prompt snapshots (cross-member AI audit),
 * workspace isolation. Only database rows are involved: no AI, no GitHub, no usage.
 */
import { PrismaClient } from '@prisma/client';
import {
  RELIABILITY_MAX_RETRY_ATTEMPTS,
  RELIABILITY_STALE_AFTER_MS,
  usagePeriodKey,
} from '@project-x/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RequestContextService } from '../../src/observability/request-context.service';
import { ReliabilityService } from '../../src/reliability/reliability.service';

const URL_ENV = process.env.MEMORY_IT_DATABASE_URL;

describe.skipIf(!URL_ENV)('Reliability safety (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let service: ReliabilityService;
  const ctx = new RequestContextService();
  let run = 0;

  beforeAll(async () => {
    const url = new URL(URL_ENV!);
    if (!url.pathname.endsWith('_it') || url.port === '5432') {
      throw new Error(`Refusing to run integration tests against ${url.host}${url.pathname}`);
    }
    prisma = new PrismaClient({ datasourceUrl: URL_ENV });
    await prisma.$connect();
    service = new ReliabilityService(prisma as never);
  });
  afterAll(async () => prisma?.$disconnect());

  /** Every call runs as an HTTP request with `X-Workspace-Id` would. */
  const as = <T>(workspaceId: string, fn: () => Promise<T>) =>
    ctx.run({ workspaceId } as never, fn);

  async function workspace(roles: Array<'owner' | 'admin' | 'member'> = ['owner']) {
    run += 1;
    const ws = `ws_rel_${run}_${Date.now()}`;
    await prisma.workspace.create({ data: { id: ws, name: ws, slug: ws } });
    const users: string[] = [];
    for (const [i, role] of roles.entries()) {
      const id = `rel_u${run}_${i}_${Date.now()}`;
      await prisma.user.create({
        data: { id, email: `${id}@it.test`, passwordHash: 'x', lastWorkspaceId: ws },
      });
      await prisma.workspaceMembership.create({
        data: { workspaceId: ws, userId: id, role, status: 'active' },
      });
      users.push(id);
    }
    return { ws, users };
  }

  const start = (ws: string, user: string, workflowId = `wf_${run}`) =>
    as(ws, () => service.startExecution(user, { workflowId, goal: 'Review PR' }));

  // ── A. retry cap ─────────────────────────────────────────────────────────────────────────

  describe('retry attempts are counted on the server', () => {
    const retry = (ws: string, user: string, id: string, attempt?: number) =>
      as(ws, () =>
        service.retryExecution(user, id, {
          stage: 'AI_FETCH',
          category: 'TIMEOUT',
          ...(attempt !== undefined ? { attempt } : {}),
        }),
      );

    it('first retry, up to the maximum, then a structured 409 with no new records', async () => {
      const { ws, users } = await workspace();
      const parent = await start(ws, users[0]!);
      await as(ws, () => service.completeExecution(users[0]!, parent.id, { status: 'failed' }));

      for (let i = 1; i <= RELIABILITY_MAX_RETRY_ATTEMPTS; i += 1) {
        const r = await retry(ws, users[0]!, parent.id);
        expect(r.decision.allowed).toBe(true);
        expect(r.execution?.trigger).toBe('retry');
      }
      const before = await prisma.workflowExecution.count({ where: { workspaceId: ws } });
      const error = await retry(ws, users[0]!, parent.id).catch((e: unknown) => e);
      expect((error as { getStatus(): number }).getStatus()).toBe(409);
      expect((error as { getResponse(): { code: string } }).getResponse().code).toBe(
        'RETRY_LIMIT_REACHED',
      );
      expect(await prisma.workflowExecution.count({ where: { workspaceId: ws } })).toBe(before);
      // The original keeps its final status (it is not reopened as `running`).
      const row = await prisma.workflowExecution.findUniqueOrThrow({ where: { id: parent.id } });
      expect(row).toMatchObject({ status: 'failed', retryCount: RELIABILITY_MAX_RETRY_ATTEMPTS });
      expect(row.completedAt).not.toBeNull();
    });

    it('a forged client attempt count cannot reset or bypass the cap', async () => {
      const { ws, users } = await workspace();
      const parent = await start(ws, users[0]!);
      for (let i = 0; i < RELIABILITY_MAX_RETRY_ATTEMPTS; i += 1) {
        await retry(ws, users[0]!, parent.id, 0); // client claims "first attempt" every time
      }
      await expect(retry(ws, users[0]!, parent.id, 0)).rejects.toMatchObject({ status: 409 });
      await expect(retry(ws, users[0]!, parent.id, -5)).rejects.toMatchObject({ status: 409 });
      await expect(retry(ws, users[0]!, parent.id, 1e9)).rejects.toMatchObject({ status: 409 });
    });

    it('concurrent retries cannot exceed the cap', async () => {
      const { ws, users } = await workspace();
      const parent = await start(ws, users[0]!);
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () => retry(ws, users[0]!, parent.id)),
      );
      const ok = results.filter((r) => r.status === 'fulfilled').length;
      expect(ok).toBe(RELIABILITY_MAX_RETRY_ATTEMPTS);
      expect(
        results.filter(
          (r) => r.status === 'rejected' && (r.reason as { status?: number }).status === 409,
        ),
      ).toHaveLength(8 - RELIABILITY_MAX_RETRY_ATTEMPTS);
      expect(
        await prisma.workflowExecution.count({ where: { parentExecutionId: parent.id } }),
      ).toBe(RELIABILITY_MAX_RETRY_ATTEMPTS);
    });

    it('the count survives a restart (a fresh service instance reads persisted state)', async () => {
      const { ws, users } = await workspace();
      const parent = await start(ws, users[0]!);
      await retry(ws, users[0]!, parent.id);
      await retry(ws, users[0]!, parent.id);
      service = new ReliabilityService(prisma as never); // "restarted process"
      await retry(ws, users[0]!, parent.id);
      await expect(retry(ws, users[0]!, parent.id)).rejects.toMatchObject({ status: 409 });
    });

    it('write-stage retries still require confirmation and create nothing', async () => {
      const { ws, users } = await workspace();
      const parent = await start(ws, users[0]!);
      const r = await as(ws, () =>
        service.retryExecution(users[0]!, parent.id, {
          stage: 'GITHUB_WRITE',
          category: 'TIMEOUT',
        }),
      );
      expect(r.decision).toMatchObject({ allowed: false, requiresConfirmation: true });
      expect(r.execution).toBeUndefined();
      const row = await prisma.workflowExecution.findUniqueOrThrow({ where: { id: parent.id } });
      expect(row.retryCount).toBe(0);
    });
  });

  // ── E. execution numbering ───────────────────────────────────────────────────────────────

  describe('execution numbering under concurrency', () => {
    it('simultaneous starts of one workflow get distinct, gap-free numbers', async () => {
      const { ws, users } = await workspace();
      const executions = await Promise.all(
        Array.from({ length: 6 }, () => start(ws, users[0]!, 'wf_concurrent')),
      );
      expect(executions.map((e) => e.executionNumber).sort((a, b) => a - b)).toEqual([
        1, 2, 3, 4, 5, 6,
      ]);
    });

    it('continues after existing history and is independent per workflow and workspace', async () => {
      const a = await workspace();
      const b = await workspace();
      await start(a.ws, a.users[0]!, 'wf_hist');
      await start(a.ws, a.users[0]!, 'wf_hist');
      service = new ReliabilityService(prisma as never); // another process
      expect((await start(a.ws, a.users[0]!, 'wf_hist')).executionNumber).toBe(3);
      expect((await start(a.ws, a.users[0]!, 'wf_other')).executionNumber).toBe(1);
      expect((await start(b.ws, b.users[0]!, 'wf_hist')).executionNumber).toBe(1);
    });
  });

  // ── C. stale executions ──────────────────────────────────────────────────────────────────

  describe('stale executions', () => {
    const age = async (id: string, ms: number) => {
      const past = new Date(Date.now() - ms);
      await prisma.$executeRaw`UPDATE workflow_executions SET updated_at = ${past}, started_at = ${past} WHERE id = ${id}`;
      await prisma.$executeRaw`UPDATE workflow_audit_events SET created_at = ${past} WHERE execution_id = ${id}`;
    };

    it('active and completed executions are preserved; an abandoned one becomes stale once', async () => {
      const { ws, users } = await workspace();
      const user = users[0]!;
      const active = await start(ws, user, 'wf_active');
      const done = await start(ws, user, 'wf_done');
      await as(ws, () => service.completeExecution(user, done.id, { status: 'completed' }));
      const abandoned = await start(ws, user, 'wf_abandoned');
      const recentEvent = await start(ws, user, 'wf_recent_event');
      await age(done.id, RELIABILITY_STALE_AFTER_MS * 2);
      await age(abandoned.id, RELIABILITY_STALE_AFTER_MS + 60_000);
      await age(recentEvent.id, RELIABILITY_STALE_AFTER_MS + 60_000);
      // …but the client recorded activity recently on this one.
      await as(ws, () =>
        service.appendAuditEvent(user, recentEvent.id, { type: 'STEP_STARTED', message: 'step' }),
      );

      // Repeated and concurrent sweeps record exactly one transition.
      await Promise.all([
        as(ws, () => service.listExecutions(user)),
        as(ws, () => service.listExecutions(user)),
        as(ws, () => service.getExecution(user, abandoned.id)),
      ]);
      await as(ws, () => service.listExecutions(user));

      const status = async (id: string) =>
        (await prisma.workflowExecution.findUniqueOrThrow({ where: { id } })).status;
      expect(await status(active.id)).toBe('running');
      expect(await status(recentEvent.id)).toBe('running');
      expect(await status(done.id)).toBe('completed');
      expect(await status(abandoned.id)).toBe('stale');
      const marks = await prisma.workflowAuditEvent.count({
        where: { executionId: abandoned.id, type: 'WORKFLOW_ABANDONED' },
      });
      expect(marks).toBe(1);
      // History is kept; nothing was retried, replayed or created.
      expect(await prisma.workflowAuditEvent.count({ where: { executionId: abandoned.id } })).toBe(
        2,
      );
      expect(await prisma.workflowExecution.count({ where: { workspaceId: ws } })).toBe(4);
      const detail = await as(ws, () => service.getExecution(user, abandoned.id));
      expect(detail.resumeAvailable).toBe(true);
      expect(detail.timeline.map((t) => t.label)).toContain('Marked Stale (No Activity)');
    });

    it('a client that was in fact still running can still complete it', async () => {
      const { ws, users } = await workspace();
      const e = await start(ws, users[0]!);
      await age(e.id, RELIABILITY_STALE_AFTER_MS + 60_000);
      await as(ws, () => service.listExecutions(users[0]!));
      await as(ws, () => service.completeExecution(users[0]!, e.id, { status: 'completed' }));
      expect(
        (await prisma.workflowExecution.findUniqueOrThrow({ where: { id: e.id } })).status,
      ).toBe('completed');
    });

    it('sweeps only the viewer’s own executions in the selected workspace', async () => {
      const { ws, users } = await workspace(['owner', 'member']);
      const other = await start(ws, users[1]!);
      await age(other.id, RELIABILITY_STALE_AFTER_MS + 60_000);
      await as(ws, () => service.listExecutions(users[0]!));
      expect(
        (await prisma.workflowExecution.findUniqueOrThrow({ where: { id: other.id } })).status,
      ).toBe('running');
    });
  });

  // ── F. AI audit for every member ─────────────────────────────────────────────────────────

  describe('AI audit recording across workspace members', () => {
    const record = (ws: string, user: string, executionId: string) =>
      as(ws, () =>
        service.recordAiRequest(user, executionId, {
          provider: 'openai',
          model: 'm',
          status: 'completed',
          promptBody: 'You are a careful PR reviewer.', // the same server prompt for everyone
          capability: 'REVIEW_ENTIRE_PR',
        }),
      );

    it('owner, admin and member each record their own audit with the shared prompt version', async () => {
      const { ws, users } = await workspace(['owner', 'admin', 'member']);
      const snaps = [];
      for (const user of users) {
        const e = await start(ws, user, `wf_${user}`);
        snaps.push(await record(ws, user, e.id));
        const row = await prisma.workflowExecution.findUniqueOrThrow({ where: { id: e.id } });
        expect(row.userId).toBe(user); // attribution stays with the member
        expect((row.aiRequestsJson as unknown[]).length).toBe(1);
      }
      expect(new Set(snaps.map((s) => s.promptHash)).size).toBe(1);
      expect(new Set(snaps.map((s) => s.promptVersion))).toEqual(new Set(['1']));
      expect(await prisma.promptSnapshot.count({ where: { workspaceId: ws } })).toBe(1);
    });

    it('concurrent first recordings by different members do not fail', async () => {
      const { ws, users } = await workspace(['owner', 'member', 'member']);
      const executions = await Promise.all(users.map((u) => start(ws, u, `wf_c_${u}`)));
      const results = await Promise.allSettled(
        users.map((u, i) => record(ws, u, executions[i]!.id)),
      );
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      expect(await prisma.promptSnapshot.count({ where: { workspaceId: ws } })).toBe(1);
    });

    it('a member cannot record into another member’s execution; other workspaces are invisible', async () => {
      const { ws, users } = await workspace(['owner', 'member']);
      const owners = await start(ws, users[0]!);
      await expect(record(ws, users[1]!, owners.id)).rejects.toMatchObject({ status: 404 });
      const other = await workspace();
      await expect(record(other.ws, other.users[0]!, owners.id)).rejects.toMatchObject({
        status: 404,
      });
      // …and selecting a workspace you are not a member of is refused outright.
      await expect(record(ws, other.users[0]!, owners.id)).rejects.toMatchObject({
        status: 403,
      });
      const row = await prisma.workflowExecution.findUniqueOrThrow({ where: { id: owners.id } });
      expect(row.aiRequestsJson).toEqual([]);
    });

    it('best-effort audit from the AI path never throws, even when denied', async () => {
      const { ws, users } = await workspace(['owner', 'member']);
      const owners = await start(ws, users[0]!);
      await expect(
        as(ws, () =>
          service.recordAiRequestBestEffort(users[1]!, owners.id, {
            provider: 'openai',
            model: 'm',
            status: 'completed',
          }),
        ),
      ).resolves.toBeUndefined();
    });
  });

  // ── isolation / replay ───────────────────────────────────────────────────────────────────

  describe('replay and resume authorization', () => {
    it('only the owner, in the right workspace, can replay or resume; replay itself charges nothing', async () => {
      const { ws, users } = await workspace(['owner', 'member']);
      const e = await start(ws, users[0]!);
      await as(ws, () => service.completeExecution(users[0]!, e.id, { status: 'failed' }));
      await expect(
        as(ws, () => service.replayExecution(users[1]!, e.id, {})),
      ).rejects.toMatchObject({ status: 404 });
      await expect(as(ws, () => service.resumeExecution(users[1]!, e.id))).rejects.toMatchObject({
        status: 404,
      });
      const outsider = await workspace();
      await expect(
        as(ws, () => service.replayExecution(outsider.users[0]!, e.id, {})),
      ).rejects.toMatchObject({ status: 403 });

      const replay = await as(ws, () => service.replayExecution(users[0]!, e.id, {}));
      expect(replay.trigger).toBe('replay');
      // The replay record is bookkeeping only: AI steps re-run later as normal, individually
      // authorized and metered AI requests. Nothing was charged here.
      expect(
        await prisma.workspaceUsageCounter.count({
          where: { workspaceId: ws, periodKey: usagePeriodKey() },
        }),
      ).toBe(0);
    });
  });
});
