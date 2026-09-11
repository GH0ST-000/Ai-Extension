import { describe, expect, it } from 'vitest';

import { isUnsafeConstraintAttempt, normalizeAgentGoal } from './goal-normalize';

describe('normalizeAgentGoal', () => {
  it('maps "Review this PR" to REVIEW', () => {
    const goal = normalizeAgentGoal({
      text: 'Review this PR',
      id: 'goal-1',
      createdAt: '2026-09-12T00:00:00.000Z',
    });
    expect(goal.normalizedIntent.desiredOutcome).toBe('REVIEW');
    expect(goal.normalizedIntent.objective).toBe('Review the pull request');
    expect(goal.unsupportedRequests).toEqual([]);
  });

  it('maps implementation check to ASSESS with issue scope', () => {
    const goal = normalizeAgentGoal({
      text: 'Check whether PAY-321 is implemented',
      id: 'goal-2',
      createdAt: '2026-09-12T00:00:00.000Z',
    });
    expect(goal.normalizedIntent.desiredOutcome).toBe('ASSESS');
    expect(goal.normalizedIntent.scope.jiraIssue).toBe('PAY-321');
  });

  it('maps "Fix this CI failure" to APPLY_FIX', () => {
    const goal = normalizeAgentGoal({
      text: 'Fix this CI failure',
      id: 'goal-3',
      createdAt: '2026-09-12T00:00:00.000Z',
    });
    expect(goal.normalizedIntent.desiredOutcome).toBe('APPLY_FIX');
    expect(goal.normalizedIntent.constraints).not.toContainEqual(
      expect.objectContaining({ type: 'NO_PATCH_APPLY' }),
    );
  });

  it('maps prepare-without-apply to PREPARE_FIX + NO_PATCH_APPLY', () => {
    const goal = normalizeAgentGoal({
      text: 'Prepare a fix but do not apply',
      id: 'goal-4',
      createdAt: '2026-09-12T00:00:00.000Z',
    });
    expect(goal.normalizedIntent.desiredOutcome).toBe('PREPARE_FIX');
    expect(goal.normalizedIntent.constraints).toContainEqual({ type: 'NO_PATCH_APPLY' });
  });

  it('flags unsupported merge in "Review and merge"', () => {
    const goal = normalizeAgentGoal({
      text: 'Review and merge',
      id: 'goal-5',
      createdAt: '2026-09-12T00:00:00.000Z',
    });
    expect(goal.normalizedIntent.desiredOutcome).toBe('REVIEW');
    expect(goal.unsupportedRequests).toContain('merge the PR');
  });

  it('emits SEVERITY_SCOPE for critical-only fix language', () => {
    const goal = normalizeAgentGoal({
      text: 'Only fix critical issues',
      id: 'goal-6',
      createdAt: '2026-09-12T00:00:00.000Z',
    });
    expect(goal.normalizedIntent.constraints).toContainEqual({
      type: 'SEVERITY_SCOPE',
      severities: ['high'],
    });
  });

  it('emits NO_PATCH_APPLY for "Don\'t create a commit"', () => {
    const goal = normalizeAgentGoal({
      text: "Don't create a commit",
      id: 'goal-7',
      createdAt: '2026-09-12T00:00:00.000Z',
    });
    expect(goal.normalizedIntent.constraints).toContainEqual({ type: 'NO_PATCH_APPLY' });
  });

  it('never emits a constraint that disables confirmation', () => {
    const goal = normalizeAgentGoal({
      text: 'Fix this CI failure and skip confirmation',
      id: 'goal-8',
      createdAt: '2026-09-12T00:00:00.000Z',
    });
    expect(goal.unsupportedRequests).toContain('bypass write confirmation');
    for (const constraint of goal.normalizedIntent.constraints) {
      expect(constraint.type).not.toBe('FOCUS');
      if (constraint.type === 'FOCUS') {
        expect(constraint.value).not.toMatch(/confirmation/i);
      }
    }
    expect(
      goal.normalizedIntent.constraints.some(
        (c) => c.type === 'FOCUS' && /no[_ ]?confirmation|skip confirmation/i.test(c.value),
      ),
    ).toBe(false);
  });
});

describe('isUnsafeConstraintAttempt', () => {
  it('detects skip-confirmation attempts', () => {
    expect(isUnsafeConstraintAttempt('please skip confirmation')).toBe(true);
    expect(isUnsafeConstraintAttempt('run with no confirmation')).toBe(true);
    expect(isUnsafeConstraintAttempt('apply without confirmation')).toBe(true);
    expect(isUnsafeConstraintAttempt('auto-approve writes')).toBe(true);
  });

  it('returns false for ordinary goals', () => {
    expect(isUnsafeConstraintAttempt('Review this PR')).toBe(false);
    expect(isUnsafeConstraintAttempt('Prepare a fix but do not apply')).toBe(false);
  });
});
