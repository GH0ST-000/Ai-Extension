/**
 * Product analytics (activation funnel) — PostgreSQL + real HTTP.
 *
 * Real: InternalAnalyticsController, ProductAnalyticsService (raw SQL), RateLimitGuard
 * (in-memory counter), ValidationPipe. Seeded data lives in a 2020 signup / report window so
 * concurrent integration files cannot affect the exact cohort numbers; platform-wide sections
 * (current memory adoption, billing) are asserted as lower bounds.
 */
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { InternalAnalyticsController } from '../../src/analytics/internal-analytics.controller';
import {
  ProductAnalyticsService,
  type ProductAnalyticsReport,
} from '../../src/analytics/product-analytics.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { RedisService } from '../../src/redis/redis.service';
import { RateLimitGuard } from '../../src/common/security/rate-limit.guard';

const URL_ENV = process.env.MEMORY_IT_DATABASE_URL;
const TOKEN = 'it-internal-analytics-token-0123456789';
const CONFIG: Record<string, unknown> = {
  nodeEnv: 'development',
  observability: { internalToken: TOKEN },
};
const configGet = (path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>(
      (v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined),
      CONFIG,
    );

const FROM = '2020-01-01T00:00:00.000Z';
const TO = '2020-03-01T00:00:00.000Z';
const DAY = 24 * 60 * 60 * 1000;
const at = (iso: string, plusMs = 0) => new Date(new Date(iso).getTime() + plusMs);

describe.skipIf(!URL_ENV)('Product analytics (PostgreSQL + HTTP)', () => {
  let prisma: PrismaClient;
  let app: INestApplication;
  let baseUrl: string;
  const counters = new Map<string, number>();
  const tag = randomBytes(4).toString('hex');
  const ids: Record<string, string> = {};
  const workspaceIds: string[] = [];
  const userIds: string[] = [];

  async function user(key: string, createdAt: Date) {
    const row = await prisma.user.create({
      data: { email: `pa_${key}_${tag}@it.test`, passwordHash: 'x', createdAt },
    });
    ids[key] = row.id;
    userIds.push(row.id);
    return row.id;
  }

  async function workspace(key: string) {
    const row = await prisma.workspace.create({
      data: { name: `pa ${key}`, slug: `pa-${key}-${tag}` },
    });
    ids[key] = row.id;
    workspaceIds.push(row.id);
    return row.id;
  }

  let op = 0;
  async function report(input: {
    userId: string;
    workspaceId: string;
    status: 'completed' | 'partial' | 'failed';
    at: Date;
    pr: number;
    headSha?: string | null;
    memoryApplied?: boolean;
  }) {
    op += 1;
    await prisma.prReviewReport.create({
      data: {
        workspaceId: input.workspaceId,
        userId: input.userId,
        operationId: `pa-op-${tag}-${op}`,
        owner: 'secret-owner',
        repository: 'secret-repo',
        pullRequestNumber: input.pr,
        pullRequestTitle: 'SECRET PR TITLE',
        headSha: input.headSha === undefined ? `sha${op}` : input.headSha,
        status: input.status,
        memoryMode: 'on',
        memoryStatus: input.memoryApplied ? 'applied' : 'skipped',
        snapshot: { version: 1, findings: [] },
        startedAt: input.at,
        completedAt: input.at,
        createdAt: input.at,
      },
    });
  }

  beforeAll(async () => {
    const url = new URL(URL_ENV!);
    if (!url.pathname.endsWith('_it') || url.port === '5432') {
      throw new Error(`Refusing to run integration tests against ${url.host}${url.pathname}`);
    }
    prisma = new PrismaClient({ datasourceUrl: URL_ENV });
    await prisma.$connect();
    const moduleRef = await Test.createTestingModule({
      controllers: [InternalAnalyticsController],
      providers: [
        ProductAnalyticsService,
        RateLimitGuard,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: configGet } },
        {
          provide: RedisService,
          useValue: {
            status: 'ready',
            incr: async (k: string) => {
              const n = (counters.get(k) ?? 0) + 1;
              counters.set(k, n);
              return n;
            },
            expire: async () => 1,
          },
        },
      ],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1');

    // ── seed: signup cohort Jan–Feb 2020 ────────────────────────────────────
    const signup = '2020-01-10T09:00:00.000Z';
    const ws1 = await workspace('ws1');
    const ws2 = await workspace('ws2');
    const u1 = await user('u1', at(signup)); // activated in 2d, repeats, uses memory
    const u2 = await user('u2', at(signup)); // activated in 8d, re-ran the same commit only
    const u3 = await user('u3', at(signup)); // teammate of u1, only a failed review
    await user('u4', at(signup)); // pre-tracking user, no activity
    const u5 = await user('u5', at('2020-02-27T00:00:00.000Z')); // activated at exactly 7d
    const outsider = await user('outsider', at('2020-03-05T00:00:00.000Z'));

    await prisma.workspaceMembership.createMany({
      data: [
        { workspaceId: ws1, userId: u1, role: 'owner' },
        { workspaceId: ws1, userId: u3, role: 'member' },
        { workspaceId: ws2, userId: u2, role: 'owner' },
        { workspaceId: ws2, userId: u5, role: 'member' },
      ],
    });
    await prisma.userSettings.createMany({
      data: [
        { userId: u1, professionalRole: 'tech_lead', profileCompletedAt: at(signup, 60_000) },
        { userId: u2, profileSkippedAt: at(signup, 60_000) },
      ],
    });
    await prisma.userAcquisition.createMany({
      data: [
        { userId: u1, signupClient: 'dashboard', utmSource: 'newsletter' },
        { userId: u2, signupClient: 'extension' },
        { userId: u3, signupClient: 'dashboard', referrerHost: 'news.ycombinator.com' },
        { userId: u5, signupClient: 'dashboard', utmSource: 'newsletter' },
      ],
    });

    await report({
      userId: u1,
      workspaceId: ws1,
      status: 'completed',
      at: at(signup, 2 * DAY),
      pr: 1,
    });
    await report({
      userId: u1,
      workspaceId: ws1,
      status: 'partial',
      at: at(signup, 10 * DAY),
      pr: 2,
      memoryApplied: true,
    });
    // Same logical review twice (same PR + head commit, two executions): counts once.
    await report({
      userId: u2,
      workspaceId: ws2,
      status: 'completed',
      at: at(signup, 8 * DAY),
      pr: 7,
      headSha: 'samesha',
    });
    await report({
      userId: u2,
      workspaceId: ws2,
      status: 'completed',
      at: at(signup, 8 * DAY + 60_000),
      pr: 7,
      headSha: 'samesha',
    });
    await report({
      userId: u3,
      workspaceId: ws1,
      status: 'failed',
      at: at(signup, 5 * DAY),
      pr: 3,
    });
    // u5: exactly 7 days → within the 7-day window. Report itself is after the window.
    await report({
      userId: u5,
      workspaceId: ws2,
      status: 'completed',
      at: at('2020-03-05T00:00:00.000Z'),
      pr: 9,
    });
    await report({
      userId: outsider,
      workspaceId: ws2,
      status: 'completed',
      at: at('2020-03-06T00:00:00.000Z'),
      pr: 10,
    });

    await prisma.projectMemory.create({
      data: {
        userId: u1,
        createdByUserId: u1,
        workspaceId: ws1,
        visibility: 'workspace',
        owner: 'secret-owner',
        repository: 'secret-repo',
        category: 'conventions',
        key: `pa-rule-${tag}`,
        valueJson: { summary: 'SECRET RULE TEXT' },
        confidence: 'high',
        scopeJson: {},
        provenanceJson: {},
        scopeFingerprint: `fp-${tag}`,
      },
    });
    await prisma.workspaceSubscription.create({
      data: {
        workspaceId: ws1,
        planId: 'pro',
        status: 'active',
        providerSubscriptionId: `sub_pa_${tag}`,
        cancelAtPeriodEnd: true,
      },
    });
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.prReviewReport.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
      await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await app?.close();
    await prisma?.$disconnect();
  });

  beforeEach(() => counters.clear());

  async function get(query: string, headers: Record<string, string> = {}) {
    const res = await fetch(`${baseUrl}/api/internal/analytics/activation${query}`, { headers });
    const text = await res.text();
    return {
      status: res.status,
      text,
      body: (text ? JSON.parse(text) : {}) as ProductAnalyticsReport,
    };
  }
  const authed = (query = `?from=${FROM}&to=${TO}`) => get(query, { 'x-internal-token': TOKEN });

  it('activation funnel for the cohort: exact counts', async () => {
    const { status, body } = await authed();
    expect(status).toBe(200);
    expect(body.signupCohort).toEqual({
      signups: 5,
      activated: 3, // u1, u2, u5 (u3 failed; outsider signed up after the window)
      activationRate: 0.6,
      matureForSevenDay: 5,
      activatedWithinSevenDays: 2, // u1 (2d), u5 (exactly 7d); u2 took 8d
      sevenDayActivationRate: 0.4,
      medianHoursToFirstReview: null, // fewer than 5 activated users
      repeatReviewers: 1, // u1; u2's two executions are the same PR + commit
      repeatRate: 0.3333,
      attemptedWithoutSuccess: 1, // u3
    });
    const funnel = Object.fromEntries(body.funnel.map((s) => [s.step, s.users]));
    expect(funnel).toEqual({
      signup_completed: 5,
      profile_questions_answered_or_skipped: 2,
      github_connected_now: 0,
      pr_review_attempted: 4,
      first_pr_review_completed: 3,
      pr_review_repeated: 1,
      project_memory_active_rule_created: 1,
    });
    expect(body.dataCoverage.cohortUsersWithoutAcquisitionRecord).toBe(1);
  });

  it('a teammate is not activated by someone else’s review in a shared workspace', async () => {
    // u3 shares ws1 with u1 (two successful reviews there) but has only a failed one.
    const { body } = await authed();
    expect(body.signupCohort.attemptedWithoutSuccess).toBe(1);
    expect(body.signupCohort.activated).toBe(3);
  });

  it('activity in the window: success vs failure, Project Memory applied', async () => {
    const { body } = await authed();
    expect(body.activity).toEqual({
      successfulReviews: 4, // u1 ×2, u2 ×2 (u5 / outsider reports are after the window)
      failedReviews: 1,
      workspacesWithSuccessfulReviews: 2,
      reviewsWithProjectMemoryApplied: 1,
      usersWithProjectMemoryApplied: 1,
      workspacesWithProjectMemoryApplied: 1,
    });
  });

  it('segments fold small groups (no single person identifiable by segment)', async () => {
    const { body } = await authed();
    for (const rows of Object.values(body.segments)) {
      expect(rows.reduce((sum, r) => sum + r.signups, 0)).toBe(5);
      for (const r of rows) {
        if (!r.segment.startsWith('other')) expect(r.signups).toBeGreaterThanOrEqual(5);
      }
    }
    // newsletter (2), referrer (1), direct (1), pre-tracking (1): all too small to name.
    expect(body.segments.acquisitionSource).toEqual([
      { segment: 'other (groups < 5 users)', signups: 5, activated: 3, activationRate: 0.6 },
    ]);
    expect(body.segments.usageIntent).toEqual([
      { segment: 'unanswered', signups: 5, activated: 3, activationRate: 0.6 },
    ]);
  });

  it('platform-wide memory adoption and billing include the seeded rows (lower bounds)', async () => {
    const { body } = await authed();
    expect(body.projectMemory.usersWithActiveRule).toBeGreaterThanOrEqual(1);
    expect(body.projectMemory.workspacesWithActiveSharedRule).toBeGreaterThanOrEqual(1);
    expect(body.billing.activePaid).toBeGreaterThanOrEqual(1);
    expect(body.billing.scheduledToCancel).toBeGreaterThanOrEqual(1);
    expect(body.billing.workspacesEverSubscribed).toBeGreaterThanOrEqual(1);
    expect(body.billing.totalWorkspaces).toBeGreaterThanOrEqual(2);
  });

  it('the report never contains emails, ids, repository names, PR titles or rule text', async () => {
    const { text } = await authed();
    expect(text).not.toMatch(/@it\.test|secret-owner|secret-repo|SECRET|samesha/);
    for (const id of Object.values(ids)) expect(text).not.toContain(id);
  });

  it('unauthorized access is rejected', async () => {
    expect((await get(`?from=${FROM}&to=${TO}`)).status).toBe(401);
    expect((await get('', { 'x-internal-token': 'wrong-token-wrong-token-1234' })).status).toBe(
      401,
    );
    // A user's JWT (any bearer that is not the operator token) never works.
    expect((await get('', { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.sig' })).status).toBe(
      401,
    );
    expect((await get('', { authorization: `Bearer ${TOKEN}` })).status).toBe(200);
  });

  it('is closed in every environment when the operator token is not configured', async () => {
    const observability = CONFIG.observability as { internalToken: string };
    observability.internalToken = '';
    try {
      expect((await get('', { 'x-internal-token': '' })).status).toBe(401);
      expect((await get('', { 'x-internal-token': TOKEN })).status).toBe(401);
    } finally {
      observability.internalToken = TOKEN;
    }
  });

  it('rejects unbounded or malformed windows', async () => {
    expect((await authed('?from=2018-01-01&to=2020-01-01')).status).toBe(400);
    expect((await authed('?from=nope')).status).toBe(400);
    expect((await authed(`?from=${TO}&to=${FROM}`)).status).toBe(400);
  });
});
