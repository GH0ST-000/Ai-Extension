import type { WorkflowExecutionBudget } from '@project-x/types';
import {
  WORKFLOW_MAX_AI_CALLS,
  WORKFLOW_MAX_PROVIDER_READS,
  WORKFLOW_MAX_REPLANS,
  WORKFLOW_MAX_STEPS,
  WORKFLOW_MAX_WRITE_CHECKPOINTS,
} from '@project-x/types';

export function createWorkflowBudget(
  overrides?: Partial<{
    aiCalls: number;
    providerReads: number;
    writeCheckpoints: number;
    replans: number;
    steps: number;
  }>,
): WorkflowExecutionBudget {
  return {
    aiCalls: { used: 0, max: overrides?.aiCalls ?? WORKFLOW_MAX_AI_CALLS },
    providerReads: { used: 0, max: overrides?.providerReads ?? WORKFLOW_MAX_PROVIDER_READS },
    writeCheckpoints: {
      used: 0,
      max: overrides?.writeCheckpoints ?? WORKFLOW_MAX_WRITE_CHECKPOINTS,
    },
    replans: { used: 0, max: overrides?.replans ?? WORKFLOW_MAX_REPLANS },
    steps: { used: 0, max: overrides?.steps ?? WORKFLOW_MAX_STEPS },
  };
}

export type BudgetCounter = keyof WorkflowExecutionBudget;

export function incrementBudget(
  budget: WorkflowExecutionBudget,
  counter: BudgetCounter,
  by = 1,
): WorkflowExecutionBudget {
  const entry = budget[counter];
  return {
    ...budget,
    [counter]: { ...entry, used: entry.used + by },
  };
}

export function isBudgetExceeded(
  budget: WorkflowExecutionBudget,
  counter?: BudgetCounter,
): boolean {
  if (counter) {
    return budget[counter].used >= budget[counter].max;
  }
  return (Object.keys(budget) as BudgetCounter[]).some(
    (key) => budget[key].used >= budget[key].max,
  );
}

export function wouldExceedBudget(
  budget: WorkflowExecutionBudget,
  counter: BudgetCounter,
  by = 1,
): boolean {
  return budget[counter].used + by > budget[counter].max;
}

export function budgetExceededMessage(budget: WorkflowExecutionBudget): string {
  const exceeded = (Object.keys(budget) as BudgetCounter[]).find(
    (key) => budget[key].used >= budget[key].max,
  );
  return exceeded
    ? `Project X reached the safe execution limit for this workflow (${exceeded}).`
    : 'Project X reached the safe execution limit for this workflow.';
}
