import type { WorkflowFact, WorkflowStepCondition } from '@project-x/types';

import { conditionTypeToFactName, factAsBoolean } from './facts';

export interface WorkflowConditionState {
  hasHighFindings: boolean;
  hasBlockingFindings: boolean;
  ciTargetFailed: boolean;
  ciTargetPassed: boolean;
  ciDifferentFailure: boolean;
  hasEngineeringContext: boolean;
  patchPrepared: boolean;
  patchApplied: boolean;
  reviewDraftReady: boolean;
  contextPartial: boolean;
}

export function conditionStateFromFacts(facts: WorkflowFact[]): WorkflowConditionState {
  return {
    hasHighFindings: factAsBoolean(facts, 'HAS_HIGH_FINDINGS'),
    hasBlockingFindings: factAsBoolean(facts, 'HAS_BLOCKING_FINDINGS'),
    ciTargetFailed: factAsBoolean(facts, 'CI_TARGET_FAILED'),
    ciTargetPassed: factAsBoolean(facts, 'CI_TARGET_PASSED'),
    ciDifferentFailure: factAsBoolean(facts, 'CI_DIFFERENT_FAILURE'),
    hasEngineeringContext: factAsBoolean(facts, 'HAS_ENGINEERING_CONTEXT'),
    patchPrepared: factAsBoolean(facts, 'PATCH_PREPARED'),
    patchApplied: factAsBoolean(facts, 'PATCH_APPLIED'),
    reviewDraftReady: factAsBoolean(facts, 'REVIEW_DRAFT_READY'),
    contextPartial: factAsBoolean(facts, 'CONTEXT_PARTIAL'),
  };
}

/**
 * Deterministic condition evaluation from application facts (no AI / no eval).
 * Returns true when the step should run.
 */
export function evaluateWorkflowCondition(
  condition: WorkflowStepCondition,
  state: WorkflowConditionState,
): boolean {
  let result: boolean;
  switch (condition.type) {
    case 'ALWAYS':
      result = true;
      break;
    case 'HAS_HIGH_FINDINGS':
      result = state.hasHighFindings;
      break;
    case 'HAS_BLOCKING_FINDINGS':
      result = state.hasBlockingFindings;
      break;
    case 'CI_TARGET_FAILED':
      result = state.ciTargetFailed;
      break;
    case 'CI_TARGET_PASSED':
      result = state.ciTargetPassed;
      break;
    case 'CI_DIFFERENT_FAILURE':
      result = state.ciDifferentFailure;
      break;
    case 'HAS_ENGINEERING_CONTEXT':
      result = state.hasEngineeringContext;
      break;
    case 'PATCH_PREPARED':
      result = state.patchPrepared;
      break;
    case 'PATCH_APPLIED':
      result = state.patchApplied;
      break;
    case 'REVIEW_DRAFT_READY':
      result = state.reviewDraftReady;
      break;
    case 'CONTEXT_PARTIAL':
      result = state.contextPartial;
      break;
    default: {
      const _exhaustive: never = condition.type;
      return _exhaustive;
    }
  }

  return condition.negate ? !result : result;
}

/** Evaluate against raw facts (preferred Day 21 path). */
export function evaluateWorkflowConditionFromFacts(
  condition: WorkflowStepCondition,
  facts: WorkflowFact[],
): boolean {
  if (condition.type === 'ALWAYS') {
    return condition.negate ? false : true;
  }
  const factName = conditionTypeToFactName(condition.type);
  if (!factName) {
    return false;
  }
  const value = factAsBoolean(facts, factName);
  return condition.negate ? !value : value;
}
