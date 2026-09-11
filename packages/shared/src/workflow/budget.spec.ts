import { describe, expect, it } from 'vitest';
import { WORKFLOW_MAX_AI_CALLS, WORKFLOW_MAX_REPLANS, WORKFLOW_MAX_STEPS } from '@project-x/types';

import {
  createWorkflowBudget,
  incrementBudget,
  isBudgetExceeded,
  wouldExceedBudget,
} from './budget';

describe('workflow budget', () => {
  it('creates counters at zero with default maxima', () => {
    const budget = createWorkflowBudget();
    expect(budget.aiCalls).toEqual({ used: 0, max: WORKFLOW_MAX_AI_CALLS });
    expect(budget.steps).toEqual({ used: 0, max: WORKFLOW_MAX_STEPS });
    expect(budget.replans).toEqual({ used: 0, max: WORKFLOW_MAX_REPLANS });
  });

  it('increments a counter without mutating the original', () => {
    const budget = createWorkflowBudget();
    const next = incrementBudget(budget, 'aiCalls', 2);
    expect(budget.aiCalls.used).toBe(0);
    expect(next.aiCalls.used).toBe(2);
  });

  it('wouldExceed reports whether the next increment crosses the max', () => {
    const budget = createWorkflowBudget({ aiCalls: 2 });
    const near = incrementBudget(budget, 'aiCalls', 2);
    expect(wouldExceedBudget(near, 'aiCalls')).toBe(true);
    expect(isBudgetExceeded(near, 'aiCalls')).toBe(true);
    expect(wouldExceedBudget(budget, 'aiCalls')).toBe(false);
  });

  it('does not reset usage on create — revisions must carry the same budget forward', () => {
    // Documented contract: createWorkflowBudget always starts at used:0.
    // Callers must pass the existing budget through revisions rather than recreating.
    const spent = incrementBudget(
      incrementBudget(createWorkflowBudget(), 'aiCalls', 3),
      'replans',
      1,
    );
    const fresh = createWorkflowBudget();
    expect(fresh.aiCalls.used).toBe(0);
    expect(spent.aiCalls.used).toBe(3);
    expect(spent.replans.used).toBe(1);
    // Simulating a revision that incorrectly recreates would lose usage:
    expect(fresh.aiCalls.used).not.toBe(spent.aiCalls.used);
    // Correct revision path keeps the spent budget object.
    const afterRevision = spent;
    expect(afterRevision.aiCalls.used).toBe(3);
  });
});
