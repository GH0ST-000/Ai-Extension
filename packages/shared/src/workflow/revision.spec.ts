import { describe, expect, it } from 'vitest';
import type {
  DeveloperWorkflowPlan,
  DeveloperWorkflowStep,
  WorkflowStepResult,
} from '@project-x/types';
import { WorkflowStepType } from '@project-x/types';

import {
  applyApprovedRevision,
  buildPlanRevision,
  listCompletedStepIds,
  revisionIntroducesWrite,
} from './revision';

function step(
  id: string,
  type: DeveloperWorkflowStep['type'],
  extras?: Partial<DeveloperWorkflowStep>,
): DeveloperWorkflowStep {
  return {
    id,
    type,
    title: id,
    description: id,
    dependencies: [],
    requiredContext: ['github'],
    executionMode: extras?.mutationRisk === 'WRITE' ? 'EXPLICIT_CONFIRMATION' : 'AUTO_READ',
    mutationRisk: 'NONE',
    status: 'PENDING',
    ...extras,
  };
}

function plan(steps: DeveloperWorkflowStep[], id = 'plan-1'): DeveloperWorkflowPlan {
  return {
    id,
    goal: 'Fix CI',
    summary: 'Fix CI',
    steps,
  };
}

describe('buildPlanRevision', () => {
  it('preserves completed steps and always requires approval', () => {
    const previous = plan([
      step('review', WorkflowStepType.REVIEW_PULL_REQUEST, { status: 'SUCCEEDED' }),
      step('suggest', WorkflowStepType.SUGGEST_FIX),
      step('gen', WorkflowStepType.GENERATE_PATCH, { dependencies: ['suggest'] }),
    ]);
    const results: Record<string, WorkflowStepResult> = {
      review: { stepId: 'review', status: 'SUCCEEDED' },
    };
    const proposed = plan(
      [
        step('review', WorkflowStepType.REVIEW_PULL_REQUEST, { status: 'SUCCEEDED' }),
        step('analyze', WorkflowStepType.ANALYZE_CI_FAILURE),
        step('suggest', WorkflowStepType.SUGGEST_FIX, { dependencies: ['analyze'] }),
      ],
      'plan-2',
    );

    const revision = buildPlanRevision({
      workflowId: 'wf-1',
      previousPlan: previous,
      proposedPlan: proposed,
      results,
      reason: 'STEP_FAILED',
      summary: 'Replace remaining fix branch',
      id: 'rev-1',
    });

    expect(revision.preservedCompletedSteps).toEqual(['review']);
    expect(listCompletedStepIds(results)).toEqual(['review']);
    expect(revision.requiresApproval).toBe(true);
    expect(revision.removedRemainingSteps).toEqual(expect.arrayContaining(['gen']));
  });
});

describe('applyApprovedRevision', () => {
  it('keeps completed history and applies remaining proposed steps', () => {
    const previous = plan([
      step('review', WorkflowStepType.REVIEW_PULL_REQUEST, { status: 'SUCCEEDED' }),
      step('old', WorkflowStepType.SUGGEST_FIX),
    ]);
    const results: Record<string, WorkflowStepResult> = {
      review: { stepId: 'review', status: 'SUCCEEDED' },
    };
    const proposed = plan(
      [
        step('review', WorkflowStepType.REVIEW_PULL_REQUEST),
        step('new', WorkflowStepType.ANALYZE_CI_FAILURE),
      ],
      'plan-2',
    );
    const revision = buildPlanRevision({
      workflowId: 'wf-1',
      previousPlan: previous,
      proposedPlan: proposed,
      results,
      reason: 'NEW_INFORMATION',
      summary: 'Swap remaining work',
      id: 'rev-2',
    });

    const applied = applyApprovedRevision(previous, revision, results);
    expect(applied.steps.map((s) => s.id)).toEqual(['review', 'new']);
    expect(applied.steps[0]?.status).toBe('SUCCEEDED');
  });
});

describe('revisionIntroducesWrite', () => {
  it('detects added WRITE steps', () => {
    const previous = plan([step('prep', WorkflowStepType.PREPARE_PATCH)]);
    const proposed = plan(
      [
        step('prep', WorkflowStepType.PREPARE_PATCH),
        step('apply', WorkflowStepType.APPLY_PATCH, {
          dependencies: ['prep'],
          mutationRisk: 'WRITE',
          executionMode: 'EXPLICIT_CONFIRMATION',
        }),
      ],
      'plan-write',
    );
    const revision = buildPlanRevision({
      workflowId: 'wf-1',
      previousPlan: previous,
      proposedPlan: proposed,
      results: {},
      reason: 'USER_REQUEST',
      summary: 'Add apply',
      id: 'rev-3',
    });
    expect(revisionIntroducesWrite(revision)).toBe(true);
    expect(revision.requiresApproval).toBe(true);
  });

  it('is false when only read steps are added', () => {
    const previous = plan([step('a', WorkflowStepType.REVIEW_PULL_REQUEST)]);
    const proposed = plan(
      [
        step('a', WorkflowStepType.REVIEW_PULL_REQUEST),
        step('b', WorkflowStepType.ANALYZE_CI_FAILURE),
      ],
      'plan-read',
    );
    const revision = buildPlanRevision({
      workflowId: 'wf-1',
      previousPlan: previous,
      proposedPlan: proposed,
      results: {},
      reason: 'GOAL_NOT_SATISFIED',
      summary: 'Add analysis',
      id: 'rev-4',
    });
    expect(revisionIntroducesWrite(revision)).toBe(false);
  });
});
