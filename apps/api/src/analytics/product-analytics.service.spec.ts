import { describe, expect, it } from 'vitest';

import {
  acquisitionSourceLabel,
  classifySubscriptions,
  AnalyticsWindowError,
  median,
  resolveWindow,
  segment,
  summarizeCohort,
  type CohortRow,
} from './product-analytics.service';

const NOW = new Date('2026-11-17T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const H = 60 * 60 * 1000;

function row(overrides: Partial<CohortRow> = {}): CohortRow {
  return {
    createdAt: new Date(NOW.getTime() - 30 * DAY),
    firstSuccessAt: null,
    distinctSuccessfulReviews: 0,
    attempted: false,
    githubConnected: false,
    hasActiveRule: false,
    profileAnswered: false,
    profileSkipped: false,
    hasAcquisition: true,
    signupClient: 'dashboard',
    source: null,
    professionalRole: null,
    usageIntent: null,
    primaryGoal: null,
    ...overrides,
  };
}

describe('analytics window', () => {
  it('defaults to the last 90 days and validates input', () => {
    const w = resolveWindow(undefined, undefined, NOW);
    expect(w.to).toEqual(NOW);
    expect(NOW.getTime() - w.from.getTime()).toBe(90 * DAY);
    expect(() => resolveWindow('not-a-date', undefined, NOW)).toThrow(AnalyticsWindowError);
    expect(() => resolveWindow('2026-11-10', '2026-11-01', NOW)).toThrow(/before/);
    expect(() => resolveWindow('2024-01-01', '2026-01-01', NOW)).toThrow(/366/);
  });
});

describe('activation summary', () => {
  it('counts activation, the 7-day boundary exactly, and repeat reviewers', () => {
    const signup = new Date(NOW.getTime() - 20 * DAY);
    const rows = [
      row({
        createdAt: signup,
        firstSuccessAt: new Date(signup.getTime() + 7 * DAY),
        distinctSuccessfulReviews: 2,
      }), // exactly 7d → counts
      row({
        createdAt: signup,
        firstSuccessAt: new Date(signup.getTime() + 7 * DAY + 1000),
        distinctSuccessfulReviews: 1,
      }), // 7d + 1s → not within
      row({ createdAt: signup, attempted: true }), // failed only
      row({
        createdAt: new Date(NOW.getTime() - 2 * DAY),
        firstSuccessAt: new Date(NOW.getTime() - DAY),
        distinctSuccessfulReviews: 1,
      }), // too recent for 7-day denominator
    ];
    const s = summarizeCohort(rows, NOW);
    expect(s).toMatchObject({
      signups: 4,
      activated: 3,
      activationRate: 0.75,
      matureForSevenDay: 3,
      activatedWithinSevenDays: 1,
      sevenDayActivationRate: 0.3333,
      repeatReviewers: 1,
      repeatRate: 0.3333,
      attemptedWithoutSuccess: 1,
      medianHoursToFirstReview: null, // < 5 activated users
    });
  });

  it('reports a median only with enough data', () => {
    expect(median([1, 2, 3, 4])).toBeNull();
    expect(median([5, 1, 3, 2, 4])).toBe(3);
    expect(median([1, 2, 3, 4, 5, 6])).toBe(3.5);
    const signup = new Date(NOW.getTime() - 10 * DAY);
    const rows = [2, 4, 6, 8, 10].map((h) =>
      row({
        createdAt: signup,
        firstSuccessAt: new Date(signup.getTime() + h * H),
        distinctSuccessfulReviews: 1,
      }),
    );
    expect(summarizeCohort(rows, NOW).medianHoursToFirstReview).toBe(6);
  });

  it('empty cohorts give null rates, not NaN', () => {
    expect(summarizeCohort([], NOW)).toMatchObject({
      signups: 0,
      activationRate: null,
      repeatRate: null,
    });
  });
});

describe('segments', () => {
  it('folds groups smaller than 5 users into "other"', () => {
    const rows = [
      ...Array.from({ length: 6 }, (_, i) =>
        row({ source: 'newsletter', firstSuccessAt: i < 3 ? NOW : null }),
      ),
      ...Array.from({ length: 2 }, () => row({ source: 'rare-source' })),
      row({ hasAcquisition: false }),
    ];
    expect(segment(rows, acquisitionSourceLabel)).toEqual([
      { segment: 'newsletter', signups: 6, activated: 3, activationRate: 0.5 },
      { segment: 'other (groups < 5 users)', signups: 3, activated: 0, activationRate: 0 },
    ]);
  });

  it('labels direct and pre-tracking users distinctly', () => {
    expect(acquisitionSourceLabel(row())).toBe('direct');
    expect(acquisitionSourceLabel(row({ source: 'github.com' }))).toBe('github.com');
    expect(acquisitionSourceLabel(row({ hasAcquisition: false }))).toBe(
      'unknown (before tracking)',
    );
  });
});

describe('billing (current state)', () => {
  it('classifies Paddle subscriptions without inventing history', () => {
    expect(
      classifySubscriptions(
        [
          { plan_id: 'pro', status: 'active', cancel_at_period_end: false, n: 3 },
          { plan_id: 'team', status: 'active', cancel_at_period_end: true, n: 1 },
          { plan_id: 'pro', status: 'trialing', cancel_at_period_end: false, n: 2 },
          { plan_id: 'pro', status: 'past_due', cancel_at_period_end: false, n: 1 },
          { plan_id: 'pro', status: 'cancelled', cancel_at_period_end: true, n: 2 },
          { plan_id: 'free', status: 'active', cancel_at_period_end: false, n: 1 }, // not paying
        ],
        50,
      ),
    ).toEqual({
      activePaid: 4,
      activePaidByPlan: { pro: 3, team: 1 },
      trialing: 2,
      pastDue: 1,
      paused: 0,
      scheduledToCancel: 1,
      cancelledOrExpired: 2,
      workspacesEverSubscribed: 10,
      totalWorkspaces: 50,
    });
  });
});
