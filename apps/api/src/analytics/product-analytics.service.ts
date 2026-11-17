import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

/**
 * First-party product analytics, computed on demand from authoritative records.
 *
 * No analytics events are stored: every number below is derived from rows the product already
 * writes for its own purposes (users, pr_review_reports, project_memories, workspace
 * subscriptions, the Step 3 profile / acquisition rows). The report contains aggregates only:
 * no user ids, emails, repository names, PR content or rule text, and segments smaller than
 * MIN_SEGMENT_SIZE are folded into "other".
 */

export const SUCCESSFUL_REVIEW_STATUSES = ['completed', 'partial'] as const;
export const ACTIVATION_WINDOW_DAYS = 7;
/** Medians and segments need at least this many users to be reported. */
export const MIN_SEGMENT_SIZE = 5;
export const MAX_SEGMENTS_PER_DIMENSION = 20;
export const DEFAULT_WINDOW_DAYS = 90;
export const MAX_WINDOW_DAYS = 366;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface AnalyticsWindow {
  from: Date;
  to: Date;
}

export interface SegmentRow {
  segment: string;
  signups: number;
  activated: number;
  activationRate: number | null;
}

export interface ProductAnalyticsReport {
  generatedAt: string;
  /** Signup cohort window [from, to); activity metrics use the same window on report time. */
  window: { from: string; to: string };
  signupCohort: {
    signups: number;
    activated: number;
    activationRate: number | null;
    /** Users who signed up ≥ 7 days ago (denominator of the 7-day rate). */
    matureForSevenDay: number;
    activatedWithinSevenDays: number;
    sevenDayActivationRate: number | null;
    medianHoursToFirstReview: number | null;
    repeatReviewers: number;
    /** repeatReviewers / activated. */
    repeatRate: number | null;
    /** Tried at least one review but none succeeded (yet). */
    attemptedWithoutSuccess: number;
  };
  funnel: { step: string; users: number; source: string }[];
  segments: {
    acquisitionSource: SegmentRow[];
    signupClient: SegmentRow[];
    professionalRole: SegmentRow[];
    usageIntent: SegmentRow[];
    primaryGoal: SegmentRow[];
  };
  activity: {
    successfulReviews: number;
    failedReviews: number;
    workspacesWithSuccessfulReviews: number;
    reviewsWithProjectMemoryApplied: number;
    usersWithProjectMemoryApplied: number;
    workspacesWithProjectMemoryApplied: number;
  };
  projectMemory: {
    usersWithActiveRule: number;
    workspacesWithActiveSharedRule: number;
  };
  billing: {
    /** Current state of workspaces that have (or had) a Paddle subscription. */
    activePaid: number;
    activePaidByPlan: Record<string, number>;
    trialing: number;
    pastDue: number;
    paused: number;
    scheduledToCancel: number;
    cancelledOrExpired: number;
    workspacesEverSubscribed: number;
    totalWorkspaces: number;
  };
  dataCoverage: {
    acquisitionTrackedSince: string | null;
    profileTrackedSince: string | null;
    reviewHistorySince: string | null;
    cohortUsersWithoutAcquisitionRecord: number;
  };
}

/** One cohort member, internal only (never returned). */
export interface CohortRow {
  createdAt: Date;
  firstSuccessAt: Date | null;
  distinctSuccessfulReviews: number;
  attempted: boolean;
  githubConnected: boolean;
  hasActiveRule: boolean;
  profileAnswered: boolean;
  profileSkipped: boolean;
  hasAcquisition: boolean;
  signupClient: string | null;
  source: string | null;
  professionalRole: string | null;
  usageIntent: string | null;
  primaryGoal: string | null;
}

export class AnalyticsWindowError extends Error {}

/** Parse ?from=&to= (ISO dates). Default: the last 90 days; at most 366 days. */
export function resolveWindow(
  fromRaw: string | undefined,
  toRaw: string | undefined,
  now: Date,
): AnalyticsWindow {
  const parse = (raw: string | undefined, name: string): Date | null => {
    if (raw === undefined || raw.trim() === '') return null;
    const ms = Date.parse(raw.trim());
    if (Number.isNaN(ms)) throw new AnalyticsWindowError(`Invalid ${name} (ISO-8601 expected).`);
    return new Date(ms);
  };
  const to = parse(toRaw, 'to') ?? now;
  const from = parse(fromRaw, 'from') ?? new Date(to.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS);
  if (from.getTime() >= to.getTime()) throw new AnalyticsWindowError('from must be before to.');
  if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * DAY_MS) {
    throw new AnalyticsWindowError(`Window is limited to ${MAX_WINDOW_DAYS} days.`);
  }
  return { from, to };
}

const rate = (numerator: number, denominator: number): number | null =>
  denominator > 0 ? Math.round((numerator / denominator) * 10_000) / 10_000 : null;

export function median(values: number[]): number | null {
  if (values.length < MIN_SEGMENT_SIZE) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return Math.round(value * 100) / 100;
}

/** Group by a label; small groups are folded into "other (<5 users)". */
export function segment(rows: CohortRow[], label: (row: CohortRow) => string): SegmentRow[] {
  const groups = new Map<string, { signups: number; activated: number }>();
  for (const row of rows) {
    const key = label(row);
    const group = groups.get(key) ?? { signups: 0, activated: 0 };
    group.signups += 1;
    if (row.firstSuccessAt) group.activated += 1;
    groups.set(key, group);
  }
  const sorted = [...groups.entries()].sort((a, b) => b[1].signups - a[1].signups);
  const kept: SegmentRow[] = [];
  const other = { signups: 0, activated: 0 };
  for (const [key, group] of sorted) {
    if (group.signups >= MIN_SEGMENT_SIZE && kept.length < MAX_SEGMENTS_PER_DIMENSION) {
      kept.push({ segment: key, ...group, activationRate: rate(group.activated, group.signups) });
    } else {
      other.signups += group.signups;
      other.activated += group.activated;
    }
  }
  if (other.signups > 0) {
    kept.push({
      segment: `other (groups < ${MIN_SEGMENT_SIZE} users)`,
      ...other,
      activationRate: rate(other.activated, other.signups),
    });
  }
  return kept;
}

export function acquisitionSourceLabel(row: CohortRow): string {
  if (!row.hasAcquisition) return 'unknown (before tracking)';
  return row.source ?? 'direct';
}

/** Pure computation over cohort rows (unit-tested separately from SQL). */
export function summarizeCohort(rows: CohortRow[], now: Date) {
  const windowMs = ACTIVATION_WINDOW_DAYS * DAY_MS;
  const activated = rows.filter((r) => r.firstSuccessAt);
  const mature = rows.filter((r) => now.getTime() - r.createdAt.getTime() >= windowMs);
  const activatedWithinSevenDays = mature.filter(
    (r) => r.firstSuccessAt && r.firstSuccessAt.getTime() - r.createdAt.getTime() <= windowMs,
  ).length;
  const repeatReviewers = rows.filter((r) => r.distinctSuccessfulReviews >= 2).length;
  const hours = activated.map(
    (r) => (r.firstSuccessAt!.getTime() - r.createdAt.getTime()) / (60 * 60 * 1000),
  );
  return {
    signups: rows.length,
    activated: activated.length,
    activationRate: rate(activated.length, rows.length),
    matureForSevenDay: mature.length,
    activatedWithinSevenDays,
    sevenDayActivationRate: rate(activatedWithinSevenDays, mature.length),
    medianHoursToFirstReview: median(hours),
    repeatReviewers,
    repeatRate: rate(repeatReviewers, activated.length),
    attemptedWithoutSuccess: rows.filter((r) => r.attempted && !r.firstSuccessAt).length,
  };
}

const count = (value: unknown): number => Number(value ?? 0);

/** Current-state billing counts (only rows with a real Paddle subscription id). */
export function classifySubscriptions(
  rows: { plan_id: string; status: string; cancel_at_period_end: boolean; n: number }[],
  totalWorkspaces: number,
): ProductAnalyticsReport['billing'] {
  const result: ProductAnalyticsReport['billing'] = {
    activePaid: 0,
    activePaidByPlan: {},
    trialing: 0,
    pastDue: 0,
    paused: 0,
    scheduledToCancel: 0,
    cancelledOrExpired: 0,
    workspacesEverSubscribed: 0,
    totalWorkspaces,
  };
  for (const row of rows) {
    const n = count(row.n);
    result.workspacesEverSubscribed += n;
    if (row.status === 'active' && row.plan_id !== 'free') {
      result.activePaid += n;
      result.activePaidByPlan[row.plan_id] = (result.activePaidByPlan[row.plan_id] ?? 0) + n;
      if (row.cancel_at_period_end) result.scheduledToCancel += n;
    } else if (row.status === 'trialing') result.trialing += n;
    else if (row.status === 'past_due') result.pastDue += n;
    else if (row.status === 'paused') result.paused += n;
    else if (row.status === 'cancelled' || row.status === 'expired') {
      result.cancelledOrExpired += n;
    }
  }
  return result;
}

@Injectable()
export class ProductAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async report(window: AnalyticsWindow, now: Date = new Date()): Promise<ProductAnalyticsReport> {
    // Reporting runs off the request path of product features; a statement timeout keeps a
    // slow report from holding a connection.
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL statement_timeout = '15s'`;
        const rows = await this.cohort(tx, window, now);
        // Sequential: one connection per interactive transaction.
        const activity = await this.activity(tx, window);
        const memory = await this.memoryAdoption(tx);
        const billing = await this.billing(tx);
        const coverage = await this.coverage(tx);
        const summary = summarizeCohort(rows, now);
        const n = (predicate: (r: CohortRow) => boolean) => rows.filter(predicate).length;
        return {
          generatedAt: now.toISOString(),
          window: { from: window.from.toISOString(), to: window.to.toISOString() },
          signupCohort: summary,
          funnel: [
            { step: 'signup_completed', users: rows.length, source: 'users.created_at' },
            {
              step: 'profile_questions_answered_or_skipped',
              users: n((r) => r.profileAnswered || r.profileSkipped),
              source: 'user_settings.profile_completed_at / profile_skipped_at',
            },
            {
              step: 'github_connected_now',
              users: n((r) => r.githubConnected),
              source: 'github_connections, active github_app_installations (current state)',
            },
            {
              step: 'pr_review_attempted',
              users: n((r) => r.attempted),
              source: 'pr_review_reports (any status)',
            },
            {
              step: 'first_pr_review_completed',
              users: summary.activated,
              source: "pr_review_reports status in ('completed','partial')",
            },
            {
              step: 'pr_review_repeated',
              users: summary.repeatReviewers,
              source: 'second distinct successful review (PR + head commit)',
            },
            {
              step: 'project_memory_active_rule_created',
              users: n((r) => r.hasActiveRule),
              source: "project_memories status = 'active' (creator)",
            },
          ],
          segments: {
            acquisitionSource: segment(rows, acquisitionSourceLabel),
            signupClient: segment(rows, (r) =>
              r.hasAcquisition ? (r.signupClient ?? 'unknown') : 'unknown (before tracking)',
            ),
            professionalRole: segment(rows, (r) => r.professionalRole ?? 'unanswered'),
            usageIntent: segment(rows, (r) => r.usageIntent ?? 'unanswered'),
            primaryGoal: segment(rows, (r) => r.primaryGoal ?? 'unanswered'),
          },
          activity,
          projectMemory: memory,
          billing,
          dataCoverage: {
            ...coverage,
            cohortUsersWithoutAcquisitionRecord: n((r) => !r.hasAcquisition),
          },
        };
      },
      { timeout: 20_000 },
    );
  }

  private async cohort(
    tx: Prisma.TransactionClient,
    window: AnalyticsWindow,
    now: Date,
  ): Promise<CohortRow[]> {
    const rows = await tx.$queryRaw<
      {
        created_at: Date;
        first_success_at: Date | null;
        distinct_successful: number;
        attempted: boolean;
        github_connected: boolean;
        has_active_rule: boolean;
        profile_completed: boolean;
        profile_skipped: boolean;
        has_acquisition: boolean;
        signup_client: string | null;
        source: string | null;
        professional_role: string | null;
        usage_intent: string | null;
        primary_goal: string | null;
      }[]
    >(Prisma.sql`
      WITH cohort AS (
        SELECT u.id, u.created_at
        FROM users u
        WHERE u.created_at >= ${window.from} AND u.created_at < ${window.to}
      ),
      ok AS (
        SELECT r.user_id, r.completed_at,
               concat_ws(':', r.workspace_id, r.owner, r.repository, r.pull_request_number,
                         COALESCE(r.head_sha, r.operation_id)) AS logical_review
        FROM pr_review_reports r
        JOIN cohort c ON c.id = r.user_id
        WHERE r.status IN ('completed', 'partial') AND r.completed_at <= ${now}
      ),
      ok_per_user AS (
        SELECT user_id, min(completed_at) AS first_success_at,
               count(DISTINCT logical_review)::int AS distinct_successful
        FROM ok GROUP BY user_id
      )
      SELECT
        c.created_at,
        o.first_success_at,
        COALESCE(o.distinct_successful, 0) AS distinct_successful,
        EXISTS (SELECT 1 FROM pr_review_reports r WHERE r.user_id = c.id) AS attempted,
        (EXISTS (SELECT 1 FROM github_connections g WHERE g.user_id = c.id)
          OR EXISTS (
            SELECT 1 FROM workspace_memberships m
            JOIN github_app_installations i
              ON i.workspace_id = m.workspace_id AND i.status = 'active'
            WHERE m.user_id = c.id AND m.status = 'active'
          )) AS github_connected,
        EXISTS (
          SELECT 1 FROM project_memories pm
          WHERE pm.status = 'active' AND COALESCE(pm.created_by_user_id, pm.user_id) = c.id
        ) AS has_active_rule,
        (s.profile_completed_at IS NOT NULL) AS profile_completed,
        (s.profile_skipped_at IS NOT NULL) AS profile_skipped,
        (a.user_id IS NOT NULL) AS has_acquisition,
        a.signup_client,
        COALESCE(a.utm_source, a.referrer_host) AS source,
        s.professional_role,
        s.usage_intent,
        s.primary_goal
      FROM cohort c
      LEFT JOIN ok_per_user o ON o.user_id = c.id
      LEFT JOIN user_settings s ON s.user_id = c.id
      LEFT JOIN user_acquisitions a ON a.user_id = c.id
    `);
    return rows.map((r) => ({
      createdAt: r.created_at,
      firstSuccessAt: r.first_success_at,
      distinctSuccessfulReviews: count(r.distinct_successful),
      attempted: r.attempted,
      githubConnected: r.github_connected,
      hasActiveRule: r.has_active_rule,
      profileAnswered: r.profile_completed,
      profileSkipped: r.profile_skipped,
      hasAcquisition: r.has_acquisition,
      signupClient: r.signup_client,
      source: r.source,
      professionalRole: r.professional_role,
      usageIntent: r.usage_intent,
      primaryGoal: r.primary_goal,
    }));
  }

  private async activity(
    tx: Prisma.TransactionClient,
    window: AnalyticsWindow,
  ): Promise<ProductAnalyticsReport['activity']> {
    const [row] = await tx.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
      SELECT
        count(*) FILTER (WHERE status IN ('completed', 'partial'))::int AS successful,
        count(*) FILTER (WHERE status = 'failed')::int AS failed,
        count(DISTINCT workspace_id) FILTER (WHERE status IN ('completed', 'partial'))::int
          AS ws_successful,
        count(*) FILTER (WHERE status IN ('completed', 'partial') AND memory_status = 'applied')::int
          AS memory_reviews,
        count(DISTINCT user_id)
          FILTER (WHERE status IN ('completed', 'partial') AND memory_status = 'applied')::int
          AS memory_users,
        count(DISTINCT workspace_id)
          FILTER (WHERE status IN ('completed', 'partial') AND memory_status = 'applied')::int
          AS memory_workspaces
      FROM pr_review_reports
      WHERE created_at >= ${window.from} AND created_at < ${window.to}
    `);
    return {
      successfulReviews: count(row?.successful),
      failedReviews: count(row?.failed),
      workspacesWithSuccessfulReviews: count(row?.ws_successful),
      reviewsWithProjectMemoryApplied: count(row?.memory_reviews),
      usersWithProjectMemoryApplied: count(row?.memory_users),
      workspacesWithProjectMemoryApplied: count(row?.memory_workspaces),
    };
  }

  private async memoryAdoption(
    tx: Prisma.TransactionClient,
  ): Promise<ProductAnalyticsReport['projectMemory']> {
    const [row] = await tx.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
      SELECT
        count(DISTINCT COALESCE(created_by_user_id, user_id))::int AS users,
        count(DISTINCT workspace_id) FILTER (WHERE visibility = 'workspace')::int AS workspaces
      FROM project_memories
      WHERE status = 'active'
    `);
    return {
      usersWithActiveRule: count(row?.users),
      workspacesWithActiveSharedRule: count(row?.workspaces),
    };
  }

  private async billing(tx: Prisma.TransactionClient): Promise<ProductAnalyticsReport['billing']> {
    const subscriptions = await tx.$queryRaw<
      { plan_id: string; status: string; cancel_at_period_end: boolean; n: number }[]
    >(Prisma.sql`
      SELECT plan_id, status, cancel_at_period_end, count(*)::int AS n
      FROM workspace_subscriptions
      WHERE provider_subscription_id IS NOT NULL
      GROUP BY plan_id, status, cancel_at_period_end
    `);
    const [{ total } = { total: 0 }] = await tx.$queryRaw<{ total: number }[]>(
      Prisma.sql`SELECT count(*)::int AS total FROM workspaces`,
    );
    return classifySubscriptions(subscriptions, count(total));
  }

  private async coverage(tx: Prisma.TransactionClient) {
    const [row] = await tx.$queryRaw<
      { acquisition: Date | null; profile: Date | null; reviews: Date | null }[]
    >(Prisma.sql`
      SELECT
        (SELECT min(created_at) FROM user_acquisitions) AS acquisition,
        (SELECT min(LEAST(profile_completed_at, profile_skipped_at)) FROM user_settings)
          AS profile,
        (SELECT min(created_at) FROM pr_review_reports) AS reviews
    `);
    return {
      acquisitionTrackedSince: row?.acquisition?.toISOString() ?? null,
      profileTrackedSince: row?.profile?.toISOString() ?? null,
      reviewHistorySince: row?.reviews?.toISOString() ?? null,
    };
  }
}
