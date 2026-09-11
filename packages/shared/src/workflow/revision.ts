import type {
  DeveloperWorkflowPlan,
  DeveloperWorkflowPlanRevision,
  DeveloperWorkflowStep,
  WorkflowPlanRevisionReason,
  WorkflowStepResult,
} from '@project-x/types';

export function listCompletedStepIds(results: Record<string, WorkflowStepResult>): string[] {
  return Object.values(results)
    .filter((r) => r.status === 'SUCCEEDED' || r.status === 'SKIPPED')
    .map((r) => r.stepId);
}

export function listRemainingStepIds(
  plan: DeveloperWorkflowPlan,
  results: Record<string, WorkflowStepResult>,
): string[] {
  const completed = new Set(listCompletedStepIds(results));
  return plan.steps.filter((s) => !completed.has(s.id)).map((s) => s.id);
}

/**
 * Build a material plan revision. Completed history is preserved; only remaining work changes.
 * requiresApproval is always true for material revisions.
 */
export function buildPlanRevision(input: {
  workflowId: string;
  previousPlan: DeveloperWorkflowPlan;
  proposedPlan: DeveloperWorkflowPlan;
  results: Record<string, WorkflowStepResult>;
  reason: WorkflowPlanRevisionReason;
  summary: string;
  id?: string;
}): DeveloperWorkflowPlanRevision {
  const preservedCompletedSteps = listCompletedStepIds(input.results);
  const preserved = new Set(preservedCompletedSteps);

  const previousRemaining = input.previousPlan.steps
    .filter((s) => !preserved.has(s.id))
    .map((s) => s.id);
  const proposedRemainingIds = new Set(
    input.proposedPlan.steps.filter((s) => !preserved.has(s.id)).map((s) => s.id),
  );

  const removedRemainingSteps = previousRemaining.filter((id) => !proposedRemainingIds.has(id));
  const previousIds = new Set(input.previousPlan.steps.map((s) => s.id));
  const addedSteps: DeveloperWorkflowStep[] = input.proposedPlan.steps
    .filter((s) => !previousIds.has(s.id) || !preserved.has(s.id))
    .filter((s) =>
      !preserved.has(s.id) && !previousRemaining.includes(s.id) ? true : !previousIds.has(s.id),
    );

  // Prefer explicit: steps in proposed that are new ids
  const trulyAdded = input.proposedPlan.steps.filter((s) => !previousIds.has(s.id));

  return {
    id: input.id ?? `rev-${Date.now()}`,
    workflowId: input.workflowId,
    previousPlanId: input.previousPlan.id,
    reason: input.reason,
    preservedCompletedSteps,
    removedRemainingSteps,
    addedSteps: trulyAdded.length > 0 ? trulyAdded : addedSteps,
    summary: input.summary,
    requiresApproval: true,
    proposedPlan: input.proposedPlan,
  };
}

/**
 * Apply an approved revision: keep completed step results, replace remaining plan steps.
 * Never rewrites completed history.
 */
export function applyApprovedRevision(
  previousPlan: DeveloperWorkflowPlan,
  revision: DeveloperWorkflowPlanRevision,
  results: Record<string, WorkflowStepResult>,
): DeveloperWorkflowPlan {
  const preserved = new Set(revision.preservedCompletedSteps);
  const completedSteps = previousPlan.steps.filter((s) => preserved.has(s.id));
  const completedIds = new Set(completedSteps.map((s) => s.id));

  const remaining = revision.proposedPlan.steps.filter((s) => !completedIds.has(s.id));

  // Ensure remaining dependencies that point at removed steps are scrubbed to completed-only
  const allowedDeps = new Set([...completedIds, ...remaining.map((s) => s.id)]);
  const normalizedRemaining = remaining.map((step) => ({
    ...step,
    dependencies: step.dependencies.filter((d) => allowedDeps.has(d)),
    status: results[step.id]?.status ?? 'PENDING',
  }));

  return {
    ...revision.proposedPlan,
    id: revision.proposedPlan.id,
    steps: [
      ...completedSteps.map((s) => ({
        ...s,
        status: results[s.id]?.status ?? s.status,
      })),
      ...normalizedRemaining,
    ],
  };
}

export function revisionIntroducesWrite(revision: DeveloperWorkflowPlanRevision): boolean {
  return revision.addedSteps.some((s) => s.mutationRisk === 'WRITE');
}
