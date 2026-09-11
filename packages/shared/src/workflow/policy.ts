import type { DeveloperWorkflowStep, WorkflowStepType } from '@project-x/types';
import {
  WORKFLOW_MAX_AI_CALLS,
  WORKFLOW_MAX_GOAL_CHARS,
  WORKFLOW_MAX_PLAN_ATTEMPTS,
  WORKFLOW_MAX_PROVIDER_READS,
  WORKFLOW_MAX_REPLANS,
  WORKFLOW_MAX_STEPS,
  WORKFLOW_MAX_WRITE_CHECKPOINTS,
} from '@project-x/types';

import { CAPABILITY_CATALOG, getCapability, isKnownWorkflowStepType } from './capabilities';

export const WORKFLOW_POLICY = {
  maxSteps: WORKFLOW_MAX_STEPS,
  maxWriteCheckpoints: WORKFLOW_MAX_WRITE_CHECKPOINTS,
  maxAiCalls: WORKFLOW_MAX_AI_CALLS,
  maxPlanAttempts: WORKFLOW_MAX_PLAN_ATTEMPTS,
  maxGoalChars: WORKFLOW_MAX_GOAL_CHARS,
  maxProviderReads: WORKFLOW_MAX_PROVIDER_READS,
  maxReplans: WORKFLOW_MAX_REPLANS,
  writesRequireConfirmation: true as const,
} as const;

/**
 * Rejects unknown / forbidden capability names. Catalog membership is the allowlist.
 */
export function assertCapabilityAllowed(type: string): asserts type is WorkflowStepType {
  if (!isKnownWorkflowStepType(type)) {
    throw new Error(`Workflow capability not allowed: ${type}`);
  }
  if (!CAPABILITY_CATALOG[type]) {
    throw new Error(`Workflow capability not allowed: ${type}`);
  }
}

/**
 * Force mutationRisk / executionMode / requiredContext from the catalog —
 * ignore planner lies about safety metadata.
 */
export function normalizeStepSafety(step: DeveloperWorkflowStep): DeveloperWorkflowStep {
  const cap = getCapability(step.type);
  return {
    ...step,
    mutationRisk: cap.mutationRisk,
    executionMode: cap.executionMode,
    requiredContext: [...cap.requiredContext],
  };
}
