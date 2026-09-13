import { describe, expect, it } from 'vitest';
import {
  buildOnboardingView,
  defaultOnboardingPreferences,
  firstValueTypeForAiAction,
  mapToUserFacingError,
  workflowStatusLabel,
} from './index';

describe('Day 28 onboarding builder', () => {
  it('starts at welcome for a brand-new signed-out user', () => {
    const view = buildOnboardingView({
      authenticated: false,
      workspaceReady: false,
      githubConnected: false,
      preferences: defaultOnboardingPreferences(),
    });
    expect(view.status).toBe('not_started');
    expect(view.nextStep).toBe('welcome');
  });

  it('skips sign-in and workspace when already ready, recommends GitHub then first action', () => {
    const mid = buildOnboardingView({
      authenticated: true,
      workspaceReady: true,
      githubConnected: false,
      preferences: {
        ...defaultOnboardingPreferences(),
        welcomeSeen: true,
      },
    });
    expect(mid.status).toBe('in_progress');
    expect(mid.nextStep).toBe('connect_github');

    const ready = buildOnboardingView({
      authenticated: true,
      workspaceReady: true,
      githubConnected: true,
      preferences: {
        ...defaultOnboardingPreferences(),
        welcomeSeen: true,
      },
    });
    expect(ready.nextStep).toBe('try_project_x');
  });

  it('completes when first value exists even without GitHub', () => {
    const view = buildOnboardingView({
      authenticated: true,
      workspaceReady: true,
      githubConnected: false,
      preferences: {
        ...defaultOnboardingPreferences(),
        welcomeSeen: true,
        firstValueAt: '2026-09-13T00:00:00.000Z',
        firstValueType: 'GENERIC_AI',
      },
    });
    expect(view.status).toBe('completed');
    expect(view.nextStep).toBeNull();
    expect(view.recommendedAction?.ctaLabel).toBe('Connect GitHub');
  });

  it('respects dismiss without blocking product use', () => {
    const view = buildOnboardingView({
      authenticated: true,
      workspaceReady: true,
      githubConnected: false,
      preferences: {
        ...defaultOnboardingPreferences(),
        dismissedAt: '2026-09-13T00:00:00.000Z',
      },
    });
    expect(view.status).toBe('dismissed');
    expect(view.nextStep).toBeNull();
  });

  it('maps AI actions to first-value types', () => {
    expect(firstValueTypeForAiAction('REVIEW_ENTIRE_PR')).toBe('PR_REVIEW');
    expect(firstValueTypeForAiAction('IMPROVE_WRITING')).toBe('GENERIC_AI');
    expect(firstValueTypeForAiAction('SUMMARIZE_JIRA_ISSUE')).toBe('JIRA_ANALYSIS');
  });
});

describe('Day 28 user-facing error mapper', () => {
  it('maps repository access distinctly from disconnected', () => {
    const repo = mapToUserFacingError({ code: 'REPOSITORY_NOT_ACCESSIBLE' });
    expect(repo.title).toMatch(/doesn't have access/i);
    expect(repo.primaryAction?.kind).toBe('grant_repo_access');

    const disconnected = mapToUserFacingError({ code: 'NOT_CONNECTED' });
    expect(disconnected.primaryAction?.kind).toBe('reconnect_github');
  });

  it('never suggests blind retry for unknown write outcome', () => {
    const unknown = mapToUserFacingError({ code: 'WRITE_OUTCOME_UNKNOWN' });
    expect(unknown.primaryAction?.kind).toBe('open_github');
    expect(unknown.secondaryAction?.kind).toBe('retry');
    expect(unknown.message).toMatch(/Check GitHub/i);
  });

  it('keeps usage limits as warnings with View plans', () => {
    const limit = mapToUserFacingError({ code: 'USAGE_LIMIT_REACHED' });
    expect(limit.severity).toBe('warning');
    expect(limit.primaryAction?.kind).toBe('view_plans');
  });

  it('sanitizes internal-looking messages', () => {
    const err = mapToUserFacingError({
      message: 'PrismaClientKnownRequestError ECONNREFUSED',
      referenceId: 'req_abc',
    });
    expect(err.message).not.toMatch(/Prisma|ECONN/i);
    expect(err.referenceId).toBe('req_abc');
  });

  it('maps workflow statuses to product language', () => {
    expect(workflowStatusLabel('USER_DECISION_REQUIRED')).toBe('Waiting for you');
    expect(workflowStatusLabel('STALE')).toBe('Needs refresh');
    expect(workflowStatusLabel('RUNNING')).toBe('In progress');
  });
});
