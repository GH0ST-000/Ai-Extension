import type {
  DeveloperWorkflowPlan,
  DeveloperWorkflowStep,
  WorkflowFact,
  WorkflowStepResult,
  WorkflowStepStatus,
} from '@project-x/types';
import {
  conditionStateFromFacts,
  evaluateWorkflowCondition,
  type WorkflowConditionState,
} from '@project-x/shared';

export type WorkflowEngineConditionState = WorkflowConditionState;

const TERMINAL_STEP: ReadonlySet<WorkflowStepStatus> = new Set([
  'SUCCEEDED',
  'FAILED',
  'SKIPPED',
  'CANCELLED',
]);

export function isStepTerminal(status: WorkflowStepStatus): boolean {
  return TERMINAL_STEP.has(status);
}

export function dependenciesSatisfied(
  step: DeveloperWorkflowStep,
  results: Record<string, WorkflowStepResult>,
): boolean {
  return step.dependencies.every((depId) => {
    const result = results[depId];
    return result?.status === 'SUCCEEDED' || result?.status === 'SKIPPED';
  });
}

/**
 * Returns true when skipping `stepId` would leave dependents with an unrecoverable gap.
 */
export function canSkipStep(
  plan: DeveloperWorkflowPlan,
  stepId: string,
  results: Record<string, WorkflowStepResult>,
): { ok: true } | { ok: false; reason: string } {
  const step = plan.steps.find((s) => s.id === stepId);
  if (!step) {
    return { ok: false, reason: 'Step not found' };
  }
  const current = results[stepId];
  if (current && isStepTerminal(current.status) && current.status !== 'FAILED') {
    return { ok: false, reason: 'Step already finished' };
  }

  const dependents = plan.steps.filter((s) => s.dependencies.includes(stepId));
  for (const dep of dependents) {
    const depResult = results[dep.id];
    if (depResult && isStepTerminal(depResult.status)) {
      continue;
    }
    void dep;
  }
  return { ok: true };
}

export function stepConditionPasses(
  step: DeveloperWorkflowStep,
  conditionState: WorkflowEngineConditionState,
): boolean {
  if (!step.condition) {
    return true;
  }
  return evaluateWorkflowCondition(step.condition, conditionState);
}

export function conditionStateFromEngineFacts(facts: WorkflowFact[]): WorkflowEngineConditionState {
  return conditionStateFromFacts(facts);
}

/**
 * Mark steps whose deps are met but whose allowlisted condition fails as SKIPPED.
 * Deterministic adaptation — does not require plan revision approval.
 */
export function applyDeterministicSkips(
  plan: DeveloperWorkflowPlan,
  results: Record<string, WorkflowStepResult>,
  conditionState: WorkflowEngineConditionState,
  nowIso: () => string = () => new Date().toISOString(),
): Record<string, WorkflowStepResult> {
  const next = { ...results };
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of plan.steps) {
      if (next[step.id] && isStepTerminal(next[step.id]!.status)) {
        continue;
      }
      if (!dependenciesSatisfied(step, next)) {
        continue;
      }
      if (stepConditionPasses(step, conditionState)) {
        continue;
      }
      next[step.id] = {
        stepId: step.id,
        status: 'SKIPPED',
        completedAt: nowIso(),
        summary: 'Skipped — condition not met',
      };
      changed = true;
    }
  }
  return next;
}

/**
 * Pick the next step that is eligible to run: deps met, not terminal, condition true.
 * Prefer plan order. Applies deterministic skips first.
 */
export function findNextRunnableStep(
  plan: DeveloperWorkflowPlan,
  results: Record<string, WorkflowStepResult>,
  conditionState: WorkflowEngineConditionState,
): { step: DeveloperWorkflowStep | null; results: Record<string, WorkflowStepResult> } {
  const withSkips = applyDeterministicSkips(plan, results, conditionState);

  for (const step of plan.steps) {
    const result = withSkips[step.id];
    if (result && isStepTerminal(result.status)) {
      continue;
    }
    if (result?.status === 'RUNNING' || result?.status === 'WAITING') {
      return { step, results: withSkips };
    }
    if (!dependenciesSatisfied(step, withSkips)) {
      continue;
    }
    if (!stepConditionPasses(step, conditionState)) {
      continue;
    }
    return { step, results: withSkips };
  }
  return { step: null, results: withSkips };
}

export function allStepsTerminal(
  plan: DeveloperWorkflowPlan,
  results: Record<string, WorkflowStepResult>,
): boolean {
  return plan.steps.every((step) => {
    const result = results[step.id];
    return result != null && isStepTerminal(result.status);
  });
}

export function markPlanStepsReady(
  plan: DeveloperWorkflowPlan,
  results: Record<string, WorkflowStepResult>,
): DeveloperWorkflowPlan {
  const steps = plan.steps.map((step) => {
    const result = results[step.id];
    if (result && isStepTerminal(result.status)) {
      return { ...step, status: result.status };
    }
    if (result?.status === 'RUNNING' || result?.status === 'WAITING') {
      return { ...step, status: result.status };
    }
    if (dependenciesSatisfied(step, results)) {
      return { ...step, status: 'READY' as const };
    }
    return { ...step, status: 'PENDING' as const };
  });
  return { ...plan, steps };
}
