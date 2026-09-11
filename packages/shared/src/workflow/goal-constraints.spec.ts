import { describe, expect, it } from 'vitest';
import type {
  DeveloperAgentGoal,
  DeveloperWorkflowPlan,
  DeveloperWorkflowStep,
} from '@project-x/types';
import { WorkflowStepType } from '@project-x/types';

import {
  parseCompletionCriteria,
  validateCompletionCriteriaAgainstPlan,
  validatePlanAgainstGoalConstraints,
} from './goal-constraints';

function step(
  id: string,
  type: DeveloperWorkflowStep['type'],
  deps: string[] = [],
): DeveloperWorkflowStep {
  const write =
    type === WorkflowStepType.APPLY_PATCH ||
    type === WorkflowStepType.SUBMIT_PR_REVIEW ||
    type === WorkflowStepType.SUBMIT_PR_COMMENT;
  return {
    id,
    type,
    title: id,
    description: id,
    dependencies: deps,
    requiredContext: ['github'],
    executionMode: write ? 'EXPLICIT_CONFIRMATION' : 'AUTO_READ',
    mutationRisk: write ? 'WRITE' : 'NONE',
    status: 'PENDING',
  };
}

function plan(
  steps: DeveloperWorkflowStep[],
  completionCriteria?: DeveloperWorkflowPlan['completionCriteria'],
): DeveloperWorkflowPlan {
  return {
    id: 'plan-1',
    goal: 'goal',
    summary: 'summary',
    steps,
    ...(completionCriteria ? { completionCriteria } : {}),
  };
}

function goal(
  constraints: DeveloperAgentGoal['normalizedIntent']['constraints'],
): DeveloperAgentGoal {
  return {
    id: 'g1',
    originalText: 'test',
    normalizedIntent: {
      objective: 'test',
      scope: {},
      desiredOutcome: 'CUSTOM_ALLOWED_GOAL',
      constraints,
    },
    unsupportedRequests: [],
    createdAt: '2026-09-12T00:00:00.000Z',
  };
}

describe('validatePlanAgainstGoalConstraints', () => {
  it('rejects APPLY_PATCH when goal has NO_WRITE', () => {
    const result = validatePlanAgainstGoalConstraints(
      plan([
        step('prep', WorkflowStepType.PREPARE_PATCH),
        step('apply', WorkflowStepType.APPLY_PATCH, ['prep']),
      ]),
      goal([{ type: 'NO_WRITE' }]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('AGENT_PLAN_CONFLICTS_WITH_GOAL');
  });

  it('rejects PATCH_APPLIED completion for prepare-only goals', () => {
    const result = validatePlanAgainstGoalConstraints(
      plan([step('prep', WorkflowStepType.PREPARE_PATCH)], [{ type: 'PATCH_APPLIED' }]),
      goal([{ type: 'NO_PATCH_APPLY' }]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/PATCH_APPLIED/i);
  });
});

describe('validateCompletionCriteriaAgainstPlan', () => {
  it('rejects VERIFY_CI_FIX that does not depend on APPLY_PATCH', () => {
    const result = validateCompletionCriteriaAgainstPlan(
      plan([
        step('prep', WorkflowStepType.PREPARE_PATCH),
        step('apply', WorkflowStepType.APPLY_PATCH, ['prep']),
        step('verify', WorkflowStepType.VERIFY_CI_FIX),
      ]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('AGENT_PLAN_COMPLETION_INVALID');
    expect(result.message).toMatch(/VERIFY_CI_FIX must depend on APPLY_PATCH/i);
  });

  it('accepts VERIFY_CI_FIX that depends on APPLY_PATCH', () => {
    const result = validateCompletionCriteriaAgainstPlan(
      plan([
        step('prep', WorkflowStepType.PREPARE_PATCH),
        step('apply', WorkflowStepType.APPLY_PATCH, ['prep']),
        step('verify', WorkflowStepType.VERIFY_CI_FIX, ['apply']),
      ]),
    );
    expect(result.ok).toBe(true);
  });
});

describe('parseCompletionCriteria', () => {
  it('parses known criteria and rejects unknowns', () => {
    expect(parseCompletionCriteria([{ type: 'PATCH_PREPARED' }])).toEqual([
      { type: 'PATCH_PREPARED' },
    ]);
    expect(parseCompletionCriteria([{ type: 'NOT_A_CRITERION' }])).toBeNull();
    expect(
      parseCompletionCriteria([{ type: 'ANALYSIS_PRESENTED', artifactType: 'alignment' }]),
    ).toEqual([{ type: 'ANALYSIS_PRESENTED', artifactType: 'alignment' }]);
  });
});
