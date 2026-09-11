import type {
  AgentGoalConstraint,
  DeveloperAgentGoal,
  DeveloperWorkflowPlan,
  WorkflowArtifactKind,
  WorkflowCompletionCriterion,
  WorkflowStepType,
} from '@project-x/types';
import { WorkflowStepType as Step } from '@project-x/types';

import { isKnownCompletionCriterionType } from './completion';
import {
  constraintsForbidPatchApply,
  constraintsForbidReviewSubmission,
  constraintsForbidWrites,
} from './goal-normalize';

const WRITE_TYPES = new Set<WorkflowStepType>([
  Step.APPLY_PATCH,
  Step.SUBMIT_PR_COMMENT,
  Step.SUBMIT_PR_REVIEW,
]);

const ARTIFACT_KINDS = new Set<WorkflowArtifactKind>([
  'engineering-context',
  'alignment',
  'pr-review',
  'finding',
  'ci-analysis',
  'fix-suggestion',
  'generated-patch',
  'prepared-patch',
  'commit',
  'comment-draft',
  'review-draft',
]);

export type GoalConstraintValidationResult =
  | { ok: true }
  | {
      ok: false;
      code: 'AGENT_PLAN_CONFLICTS_WITH_GOAL' | 'AGENT_PLAN_COMPLETION_INVALID';
      message: string;
    };

export function validatePlanAgainstGoalConstraints(
  plan: DeveloperWorkflowPlan,
  goal: DeveloperAgentGoal | undefined,
  constraints?: AgentGoalConstraint[],
): GoalConstraintValidationResult {
  const active = constraints ?? goal?.normalizedIntent.constraints ?? [];
  const types = new Set(plan.steps.map((s) => s.type));

  if (constraintsForbidWrites(active) && plan.steps.some((s) => WRITE_TYPES.has(s.type))) {
    return {
      ok: false,
      code: 'AGENT_PLAN_CONFLICTS_WITH_GOAL',
      message: 'Goal forbids writes, but the plan includes a write checkpoint.',
    };
  }

  if (constraintsForbidPatchApply(active) && types.has(Step.APPLY_PATCH)) {
    return {
      ok: false,
      code: 'AGENT_PLAN_CONFLICTS_WITH_GOAL',
      message: 'Goal forbids applying a patch, but the plan includes APPLY_PATCH.',
    };
  }

  if (
    constraintsForbidReviewSubmission(active) &&
    (types.has(Step.SUBMIT_PR_REVIEW) || types.has(Step.SUBMIT_PR_COMMENT))
  ) {
    return {
      ok: false,
      code: 'AGENT_PLAN_CONFLICTS_WITH_GOAL',
      message: 'Goal forbids review/comment submission, but the plan includes a submit step.',
    };
  }

  const criteria = plan.completionCriteria ?? [];
  if (constraintsForbidPatchApply(active) && criteria.some((c) => c.type === 'PATCH_APPLIED')) {
    return {
      ok: false,
      code: 'AGENT_PLAN_CONFLICTS_WITH_GOAL',
      message: 'Prepare-only goals cannot require PATCH_APPLIED completion.',
    };
  }

  if (
    constraintsForbidReviewSubmission(active) &&
    criteria.some((c) => c.type === 'REVIEW_SUBMITTED')
  ) {
    return {
      ok: false,
      code: 'AGENT_PLAN_CONFLICTS_WITH_GOAL',
      message: 'Goals that forbid submission cannot require REVIEW_SUBMITTED.',
    };
  }

  return { ok: true };
}

export function parseCompletionCriteria(raw: unknown): WorkflowCompletionCriterion[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return null;
  const out: WorkflowCompletionCriterion[] = [];

  for (const item of raw) {
    if (!item || typeof item !== 'object') return null;
    const record = item as Record<string, unknown>;
    const type = record.type;
    if (typeof type !== 'string' || !isKnownCompletionCriterionType(type)) {
      return null;
    }

    if (type === 'ANALYSIS_PRESENTED') {
      if (
        typeof record.artifactType !== 'string' ||
        !ARTIFACT_KINDS.has(record.artifactType as WorkflowArtifactKind)
      ) {
        return null;
      }
      out.push({
        type: 'ANALYSIS_PRESENTED',
        artifactType: record.artifactType as WorkflowArtifactKind,
      });
      continue;
    }

    if (type === 'CI_CHECK_VERIFIED') {
      if (record.expected !== 'PASSED') return null;
      out.push({ type: 'CI_CHECK_VERIFIED', expected: 'PASSED' });
      continue;
    }

    if (
      type === 'PR_REVIEW_COMPLETED' ||
      type === 'PATCH_PREPARED' ||
      type === 'PATCH_APPLIED' ||
      type === 'REVIEW_DRAFT_PREPARED' ||
      type === 'REVIEW_SUBMITTED'
    ) {
      out.push({ type });
      continue;
    }

    return null;
  }

  return out;
}

/**
 * Detect impossible completion criteria relative to plan capabilities.
 */
export function validateCompletionCriteriaAgainstPlan(
  plan: DeveloperWorkflowPlan,
): GoalConstraintValidationResult {
  const criteria = plan.completionCriteria ?? [];
  const types = new Set(plan.steps.map((s) => s.type));

  for (const criterion of criteria) {
    if (criterion.type === 'PATCH_APPLIED' && !types.has(Step.APPLY_PATCH)) {
      return {
        ok: false,
        code: 'AGENT_PLAN_COMPLETION_INVALID',
        message: 'PATCH_APPLIED completion requires APPLY_PATCH in the plan.',
      };
    }
    if (criterion.type === 'PATCH_PREPARED' && !types.has(Step.PREPARE_PATCH)) {
      return {
        ok: false,
        code: 'AGENT_PLAN_COMPLETION_INVALID',
        message: 'PATCH_PREPARED completion requires PREPARE_PATCH in the plan.',
      };
    }
    if (criterion.type === 'REVIEW_SUBMITTED' && !types.has(Step.SUBMIT_PR_REVIEW)) {
      return {
        ok: false,
        code: 'AGENT_PLAN_COMPLETION_INVALID',
        message: 'REVIEW_SUBMITTED completion requires SUBMIT_PR_REVIEW in the plan.',
      };
    }
    if (criterion.type === 'CI_CHECK_VERIFIED' && !types.has(Step.VERIFY_CI_FIX)) {
      return {
        ok: false,
        code: 'AGENT_PLAN_COMPLETION_INVALID',
        message: 'CI_CHECK_VERIFIED completion requires VERIFY_CI_FIX in the plan.',
      };
    }
    if (criterion.type === 'PR_REVIEW_COMPLETED' && !types.has(Step.REVIEW_PULL_REQUEST)) {
      return {
        ok: false,
        code: 'AGENT_PLAN_COMPLETION_INVALID',
        message: 'PR_REVIEW_COMPLETED requires REVIEW_PULL_REQUEST in the plan.',
      };
    }
  }

  const verify = plan.steps.find((s) => s.type === Step.VERIFY_CI_FIX);
  const apply = plan.steps.find((s) => s.type === Step.APPLY_PATCH);
  if (verify && apply) {
    const byId = new Map(plan.steps.map((s) => [s.id, s]));
    const seen = new Set<string>();
    const stack = [...verify.dependencies];
    let applyBefore = false;
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const step = byId.get(id);
      if (!step) continue;
      if (step.type === Step.APPLY_PATCH) {
        applyBefore = true;
        break;
      }
      stack.push(...step.dependencies);
    }
    if (!applyBefore) {
      return {
        ok: false,
        code: 'AGENT_PLAN_COMPLETION_INVALID',
        message: 'VERIFY_CI_FIX must depend on APPLY_PATCH when both are present.',
      };
    }
  }

  return { ok: true };
}
