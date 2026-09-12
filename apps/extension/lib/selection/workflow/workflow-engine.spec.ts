import { describe, expect, it } from 'vitest';
import type { DeveloperWorkflowPlan, WorkflowStepResult } from '@project-x/types';
import { WorkflowStepType as Step } from '@project-x/types';

import { canSkipStep, dependenciesSatisfied, findNextRunnableStep } from './workflow-engine';

function step(
  id: string,
  type: (typeof Step)[keyof typeof Step],
  deps: string[] = [],
): DeveloperWorkflowPlan['steps'][number] {
  return {
    id,
    type,
    title: id,
    description: id,
    dependencies: deps,
    requiredContext: [],
    executionMode: 'AUTO_READ',
    mutationRisk: 'NONE',
    status: 'PENDING',
  };
}

function plan(steps: DeveloperWorkflowPlan['steps']): DeveloperWorkflowPlan {
  return {
    id: 'plan-1',
    goal: 'test',
    summary: 'test',
    steps,
  };
}

const emptyState = {
  hasHighFindings: false,
  hasBlockingFindings: false,
  ciTargetFailed: false,
  ciTargetPassed: false,
  ciDifferentFailure: false,
  hasEngineeringContext: false,
  patchPrepared: false,
  patchApplied: false,
  reviewDraftReady: false,
  contextPartial: false,
};

describe('workflow-engine', () => {
  it('picks the first step with satisfied deps', () => {
    const p = plan([
      step('a', Step.BUILD_ENGINEERING_CONTEXT),
      step('b', Step.ANALYZE_ENGINEERING_ALIGNMENT, ['a']),
    ]);
    const results: Record<string, WorkflowStepResult> = {};
    expect(findNextRunnableStep(p, results, emptyState).step?.id).toBe('a');

    results.a = { stepId: 'a', status: 'SUCCEEDED' };
    expect(
      findNextRunnableStep(p, results, {
        ...emptyState,
        hasEngineeringContext: true,
      }).step?.id,
    ).toBe('b');
  });

  it('deterministically skips steps whose condition fails', () => {
    const p = plan([
      {
        ...step('a', Step.BUILD_ENGINEERING_CONTEXT),
        condition: { type: 'HAS_ENGINEERING_CONTEXT' },
      },
      step('b', Step.SUMMARIZE_JIRA),
    ]);
    const next = findNextRunnableStep(p, {}, emptyState);
    expect(next.results.a?.status).toBe('SKIPPED');
    expect(next.step?.id).toBe('b');
  });

  it('reports deps satisfied only for SUCCEEDED or SKIPPED', () => {
    const s = step('b', Step.SUGGEST_FIX, ['a']);
    expect(dependenciesSatisfied(s, { a: { stepId: 'a', status: 'FAILED' } })).toBe(false);
    expect(dependenciesSatisfied(s, { a: { stepId: 'a', status: 'SKIPPED' } })).toBe(true);
    expect(dependenciesSatisfied(s, { a: { stepId: 'a', status: 'SUCCEEDED' } })).toBe(true);
  });

  it('allows skip when step is not finished', () => {
    const p = plan([step('a', Step.BUILD_ENGINEERING_CONTEXT), step('b', Step.SUGGEST_FIX, ['a'])]);
    expect(canSkipStep(p, 'a', {}).ok).toBe(true);
    expect(canSkipStep(p, 'a', { a: { stepId: 'a', status: 'SUCCEEDED' } }).ok).toBe(false);
  });

  it('schedules Day 23 multi-repo read steps after context artifact', () => {
    const p = plan([
      step('ctx', Step.BUILD_MULTI_REPO_CONTEXT),
      step('impact', Step.ANALYZE_CHANGE_IMPACT, ['ctx']),
      step('flow', Step.TRACE_SYSTEM_FLOW, ['ctx']),
    ]);
    const results: Record<string, WorkflowStepResult> = {};
    expect(findNextRunnableStep(p, results, emptyState).step?.id).toBe('ctx');

    results.ctx = { stepId: 'ctx', status: 'SUCCEEDED' };
    expect(findNextRunnableStep(p, results, emptyState).step?.id).toBe('impact');

    results.impact = { stepId: 'impact', status: 'SUCCEEDED' };
    expect(findNextRunnableStep(p, results, emptyState).step?.id).toBe('flow');
  });
});
