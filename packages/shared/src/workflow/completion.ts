import type {
  DeveloperWorkflowPlan,
  DeveloperWorkflowSession,
  WorkflowArtifactRef,
  WorkflowBlocker,
  WorkflowCompletionCriterion,
  WorkflowGoalOutcome,
  WorkflowGoalOutcomeStatus,
  WorkflowStepResult,
} from '@project-x/types';

import { factAsBoolean } from './facts';

function criterionLabel(criterion: WorkflowCompletionCriterion): string {
  switch (criterion.type) {
    case 'ANALYSIS_PRESENTED':
      return `Analysis presented (${criterion.artifactType})`;
    case 'PR_REVIEW_COMPLETED':
      return 'PR review completed';
    case 'PATCH_PREPARED':
      return 'Patch prepared';
    case 'PATCH_APPLIED':
      return 'Patch applied';
    case 'CI_CHECK_VERIFIED':
      return `CI check verified (${criterion.expected})`;
    case 'REVIEW_DRAFT_PREPARED':
      return 'Review draft prepared';
    case 'REVIEW_SUBMITTED':
      return 'Review submitted';
    default: {
      const _exhaustive: never = criterion;
      return _exhaustive;
    }
  }
}

function hasSucceededStepOfType(
  plan: DeveloperWorkflowPlan,
  results: Record<string, WorkflowStepResult>,
  type: string,
): boolean {
  return plan.steps.some((step) => step.type === type && results[step.id]?.status === 'SUCCEEDED');
}

function hasCurrentArtifact(
  artifacts: Record<string, WorkflowArtifactRef>,
  kind: WorkflowArtifactRef['kind'],
): boolean {
  return Object.values(artifacts).some(
    (a) => a.kind === kind && (a.provenanceStatus ?? 'CURRENT') === 'CURRENT',
  );
}

export function isCompletionCriterionSatisfied(
  criterion: WorkflowCompletionCriterion,
  session: Pick<DeveloperWorkflowSession, 'plan' | 'stepResults' | 'artifacts' | 'facts'>,
): boolean {
  const facts = session.facts ?? [];
  const { plan, stepResults, artifacts } = session;

  switch (criterion.type) {
    case 'ANALYSIS_PRESENTED':
      return hasCurrentArtifact(artifacts, criterion.artifactType);
    case 'PR_REVIEW_COMPLETED':
      return (
        hasCurrentArtifact(artifacts, 'pr-review') ||
        hasSucceededStepOfType(plan, stepResults, 'REVIEW_PULL_REQUEST')
      );
    case 'PATCH_PREPARED':
      return (
        factAsBoolean(facts, 'PATCH_PREPARED') ||
        hasCurrentArtifact(artifacts, 'prepared-patch') ||
        hasSucceededStepOfType(plan, stepResults, 'PREPARE_PATCH')
      );
    case 'PATCH_APPLIED':
      return (
        factAsBoolean(facts, 'PATCH_APPLIED') ||
        hasCurrentArtifact(artifacts, 'commit') ||
        hasSucceededStepOfType(plan, stepResults, 'APPLY_PATCH')
      );
    case 'CI_CHECK_VERIFIED':
      return criterion.expected === 'PASSED' && factAsBoolean(facts, 'CI_TARGET_PASSED');
    case 'REVIEW_DRAFT_PREPARED':
      return (
        factAsBoolean(facts, 'REVIEW_DRAFT_READY') ||
        hasCurrentArtifact(artifacts, 'review-draft') ||
        hasSucceededStepOfType(plan, stepResults, 'CREATE_REVIEW_DRAFT')
      );
    case 'REVIEW_SUBMITTED':
      return hasSucceededStepOfType(plan, stepResults, 'SUBMIT_PR_REVIEW');
    default: {
      const _exhaustive: never = criterion;
      return _exhaustive;
    }
  }
}

export function evaluateCompletionCriteria(
  criteria: WorkflowCompletionCriterion[],
  session: Pick<DeveloperWorkflowSession, 'plan' | 'stepResults' | 'artifacts' | 'facts'>,
): { satisfied: string[]; unsatisfied: string[] } {
  const satisfied: string[] = [];
  const unsatisfied: string[] = [];
  for (const criterion of criteria) {
    const label = criterionLabel(criterion);
    if (isCompletionCriterionSatisfied(criterion, session)) {
      satisfied.push(label);
    } else {
      unsatisfied.push(label);
    }
  }
  return { satisfied, unsatisfied };
}

export function defaultCompletionCriteriaForOutcome(
  desiredOutcome: string,
): WorkflowCompletionCriterion[] {
  switch (desiredOutcome) {
    case 'UNDERSTAND':
      return [{ type: 'ANALYSIS_PRESENTED', artifactType: 'ci-analysis' }];
    case 'ASSESS':
      return [{ type: 'ANALYSIS_PRESENTED', artifactType: 'alignment' }];
    case 'REVIEW':
      return [{ type: 'PR_REVIEW_COMPLETED' }];
    case 'PREPARE_FIX':
      return [{ type: 'PATCH_PREPARED' }];
    case 'APPLY_FIX':
      return [{ type: 'PATCH_APPLIED' }];
    case 'VERIFY':
      return [{ type: 'CI_CHECK_VERIFIED', expected: 'PASSED' }];
    case 'PREPARE_REVIEW':
      return [{ type: 'REVIEW_DRAFT_PREPARED' }];
    default:
      return [];
  }
}

export type BuildGoalOutcomeInput = {
  session: DeveloperWorkflowSession;
  cancelled?: boolean;
  blocked?: WorkflowBlocker[];
  summaryOverride?: string;
};

/**
 * Deterministic goal outcome from trusted criteria/facts — AI prose cannot declare victory.
 */
export function buildWorkflowGoalOutcome(input: BuildGoalOutcomeInput): WorkflowGoalOutcome {
  const { session } = input;
  if (input.cancelled || session.status === 'CANCELLED') {
    return {
      status: 'CANCELLED',
      summary: input.summaryOverride ?? 'Workflow cancelled.',
      satisfiedCriteria: [],
      unsatisfiedCriteria: (session.plan.completionCriteria ?? []).map(criterionLabel),
      artifacts: Object.values(session.artifacts),
    };
  }

  if (input.blocked && input.blocked.length > 0) {
    return {
      status: 'BLOCKED',
      summary: input.summaryOverride ?? input.blocked[0]!.message,
      satisfiedCriteria: [],
      unsatisfiedCriteria: (session.plan.completionCriteria ?? []).map(criterionLabel),
      artifacts: Object.values(session.artifacts),
      blockers: input.blocked,
    };
  }

  const criteria = session.plan.completionCriteria ?? [];
  const { satisfied, unsatisfied } = evaluateCompletionCriteria(criteria, session);

  let status: WorkflowGoalOutcomeStatus;
  if (criteria.length === 0) {
    const failed = Object.values(session.stepResults).some((r) => r.status === 'FAILED');
    status = failed ? 'NOT_ACHIEVED' : 'ACHIEVED';
  } else if (unsatisfied.length === 0) {
    status = 'ACHIEVED';
  } else if (satisfied.length === 0) {
    status = 'NOT_ACHIEVED';
  } else {
    status = 'PARTIALLY_ACHIEVED';
  }

  const summary =
    input.summaryOverride ??
    (status === 'ACHIEVED'
      ? 'Goal achieved based on trusted workflow results.'
      : status === 'PARTIALLY_ACHIEVED'
        ? 'Goal partially achieved — some completion criteria remain unsatisfied.'
        : 'Goal not achieved.');

  return {
    status,
    summary,
    satisfiedCriteria: satisfied,
    unsatisfiedCriteria: unsatisfied,
    artifacts: Object.values(session.artifacts),
  };
}

export function isKnownCompletionCriterionType(type: string): boolean {
  return (
    type === 'ANALYSIS_PRESENTED' ||
    type === 'PR_REVIEW_COMPLETED' ||
    type === 'PATCH_PREPARED' ||
    type === 'PATCH_APPLIED' ||
    type === 'CI_CHECK_VERIFIED' ||
    type === 'REVIEW_DRAFT_PREPARED' ||
    type === 'REVIEW_SUBMITTED'
  );
}
