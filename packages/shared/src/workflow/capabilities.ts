import type {
  PlannerCapabilitySummary,
  PlanningCapabilityDescription,
  WorkflowArtifactKind,
  WorkflowCapabilityPrecondition,
  WorkflowContextRequirement,
  WorkflowCostClass,
  WorkflowExecutionMode,
  WorkflowMutationRisk,
  WorkflowStepType,
} from '@project-x/types';
import { WorkflowStepType as Step } from '@project-x/types';

export interface WorkflowCapabilityDefinition {
  mutationRisk: WorkflowMutationRisk;
  executionMode: WorkflowExecutionMode;
  requiredContext: WorkflowContextRequirement[];
  title: string;
  description: string;
  maxPerWorkflow?: number;
  plannerVisible: boolean;
  consumes: WorkflowArtifactKind[];
  produces: WorkflowArtifactKind[];
  costClass: WorkflowCostClass;
  preconditions: WorkflowCapabilityPrecondition[];
}

/**
 * Application-owned capability catalog. Forbidden steps (merge/shell/jira-write/…)
 * simply do not exist here — the planner cannot invent them.
 */
export const CAPABILITY_CATALOG: Record<WorkflowStepType, WorkflowCapabilityDefinition> = {
  [Step.BUILD_ENGINEERING_CONTEXT]: {
    mutationRisk: 'NONE',
    executionMode: 'AUTO_READ',
    requiredContext: [],
    title: 'Build engineering context',
    description:
      'Assemble a bounded Jira + GitHub + OpenAPI (+ optional CI) engineering context for downstream analysis.',
    plannerVisible: true,
    consumes: [],
    produces: ['engineering-context'],
    costClass: 'LOW',
    preconditions: [],
  },
  [Step.SUMMARIZE_JIRA]: {
    mutationRisk: 'NONE',
    executionMode: 'AUTO_READ',
    requiredContext: ['jira'],
    title: 'Summarize Jira issue',
    description: 'Produce a concise summary of the bound Jira issue requirements.',
    plannerVisible: true,
    consumes: [],
    produces: [],
    costClass: 'MEDIUM',
    preconditions: [
      { type: 'HAS_CONTEXT', context: 'jira' },
      { type: 'PROVIDER_CONNECTED', provider: 'jira' },
    ],
  },
  [Step.EXTRACT_ACCEPTANCE_CRITERIA]: {
    mutationRisk: 'NONE',
    executionMode: 'AUTO_READ',
    requiredContext: ['jira'],
    title: 'Extract acceptance criteria',
    description: 'Extract explicit and inferred acceptance criteria from the Jira issue.',
    plannerVisible: true,
    consumes: [],
    produces: [],
    costClass: 'MEDIUM',
    preconditions: [{ type: 'HAS_CONTEXT', context: 'jira' }],
  },
  [Step.ANALYZE_ENGINEERING_ALIGNMENT]: {
    mutationRisk: 'NONE',
    executionMode: 'AUTO_READ',
    requiredContext: [],
    title: 'Analyze engineering alignment',
    description:
      'Compare requirements, PR changes, and API contract for coverage, conflicts, and risks.',
    plannerVisible: true,
    consumes: ['engineering-context'],
    produces: ['alignment'],
    costClass: 'HIGH',
    preconditions: [
      { type: 'HAS_ARTIFACT', artifactKind: 'engineering-context' },
      { type: 'ARTIFACT_CURRENT', artifactKind: 'engineering-context' },
    ],
  },
  [Step.REVIEW_PULL_REQUEST]: {
    mutationRisk: 'NONE',
    executionMode: 'AUTO_READ',
    requiredContext: ['github'],
    title: 'Review pull request',
    description: 'Generate a structured PR review report with findings for the bound PR.',
    plannerVisible: true,
    consumes: [],
    produces: ['pr-review'],
    costClass: 'HIGH',
    preconditions: [
      { type: 'HAS_CONTEXT', context: 'github' },
      { type: 'PROVIDER_CONNECTED', provider: 'github' },
    ],
  },
  [Step.ANALYZE_API_CONTRACT]: {
    mutationRisk: 'NONE',
    executionMode: 'AUTO_READ',
    requiredContext: ['api'],
    title: 'Analyze API contract',
    description: 'Analyze the bound OpenAPI operation/document for contract risks.',
    plannerVisible: true,
    consumes: [],
    produces: [],
    costClass: 'MEDIUM',
    preconditions: [{ type: 'HAS_CONTEXT', context: 'api' }],
  },
  [Step.ANALYZE_CI_FAILURE]: {
    mutationRisk: 'NONE',
    executionMode: 'AUTO_READ',
    requiredContext: ['ci', 'github'],
    title: 'Analyze CI failure',
    description: 'Analyze failed CI checks for the bound PR head.',
    plannerVisible: true,
    consumes: [],
    produces: ['ci-analysis'],
    costClass: 'MEDIUM',
    preconditions: [{ type: 'HAS_CONTEXT', context: 'ci' }],
  },
  [Step.SUGGEST_FIX]: {
    mutationRisk: 'NONE',
    executionMode: 'AUTO_READ',
    requiredContext: ['github'],
    title: 'Suggest fix',
    description: 'Propose a concrete fix for a selected finding or CI failure target.',
    plannerVisible: true,
    consumes: ['finding', 'ci-analysis'],
    produces: ['fix-suggestion'],
    costClass: 'MEDIUM',
    preconditions: [{ type: 'HAS_CONTEXT', context: 'github' }],
  },
  [Step.GENERATE_PATCH]: {
    mutationRisk: 'NONE',
    executionMode: 'AUTO_READ',
    requiredContext: ['github'],
    title: 'Generate patch',
    description: 'Generate a patch proposal from a fix suggestion (no GitHub write).',
    plannerVisible: true,
    consumes: ['fix-suggestion'],
    produces: ['generated-patch'],
    costClass: 'MEDIUM',
    preconditions: [
      { type: 'HAS_ARTIFACT', artifactKind: 'fix-suggestion' },
      { type: 'ARTIFACT_CURRENT', artifactKind: 'fix-suggestion' },
    ],
  },
  [Step.PREPARE_PATCH]: {
    mutationRisk: 'NONE',
    executionMode: 'AUTO_READ',
    requiredContext: ['github'],
    title: 'Prepare patch',
    description: 'Prepare a generated patch for the existing apply/confirm flow.',
    plannerVisible: true,
    consumes: ['generated-patch'],
    produces: ['prepared-patch'],
    costClass: 'LOW',
    preconditions: [
      { type: 'HAS_ARTIFACT', artifactKind: 'generated-patch' },
      { type: 'ARTIFACT_CURRENT', artifactKind: 'generated-patch' },
    ],
  },
  [Step.APPLY_PATCH]: {
    mutationRisk: 'WRITE',
    executionMode: 'EXPLICIT_CONFIRMATION',
    requiredContext: ['github'],
    title: 'Apply patch',
    description: 'Commit a prepared patch to the PR branch after explicit user confirmation.',
    maxPerWorkflow: 1,
    plannerVisible: true,
    consumes: ['prepared-patch'],
    produces: ['commit'],
    costClass: 'HIGH',
    preconditions: [
      { type: 'HAS_ARTIFACT', artifactKind: 'prepared-patch' },
      { type: 'ARTIFACT_CURRENT', artifactKind: 'prepared-patch' },
      { type: 'PROVIDER_CONNECTED', provider: 'github' },
      { type: 'WRITE_PERMISSION_AVAILABLE', provider: 'github' },
      { type: 'EXPLICIT_CONFIRMATION' },
    ],
  },
  [Step.REFRESH_CI]: {
    mutationRisk: 'NONE',
    executionMode: 'AUTO_READ',
    requiredContext: ['github', 'ci'],
    title: 'Refresh CI',
    description: 'Refresh CI status for the current PR head after a change.',
    plannerVisible: true,
    consumes: [],
    produces: [],
    costClass: 'LOW',
    preconditions: [{ type: 'HAS_CONTEXT', context: 'ci' }],
  },
  [Step.VERIFY_CI_FIX]: {
    mutationRisk: 'NONE',
    executionMode: 'AUTO_READ',
    requiredContext: ['github', 'ci'],
    title: 'Verify CI fix',
    description: 'Verify whether the targeted CI failure is resolved on the new head.',
    plannerVisible: true,
    consumes: ['commit', 'ci-analysis'],
    produces: [],
    costClass: 'LOW',
    preconditions: [{ type: 'HAS_CONTEXT', context: 'ci' }],
  },
  [Step.GENERATE_PR_COMMENT]: {
    mutationRisk: 'NONE',
    executionMode: 'AUTO_READ',
    requiredContext: ['github'],
    title: 'Generate PR comment',
    description: 'Draft a PR comment from review findings (no GitHub write).',
    plannerVisible: true,
    consumes: ['pr-review'],
    produces: ['comment-draft'],
    costClass: 'MEDIUM',
    preconditions: [{ type: 'HAS_CONTEXT', context: 'github' }],
  },
  [Step.CREATE_REVIEW_DRAFT]: {
    mutationRisk: 'NONE',
    executionMode: 'AUTO_READ',
    requiredContext: ['github'],
    title: 'Create review draft',
    description: 'Create a PR review draft from findings (no GitHub write).',
    plannerVisible: true,
    consumes: ['pr-review'],
    produces: ['review-draft'],
    costClass: 'LOW',
    preconditions: [{ type: 'HAS_CONTEXT', context: 'github' }],
  },
  [Step.SUBMIT_PR_COMMENT]: {
    mutationRisk: 'WRITE',
    executionMode: 'EXPLICIT_CONFIRMATION',
    requiredContext: ['github'],
    title: 'Submit PR comment',
    description: 'Submit a prepared PR comment after explicit user confirmation.',
    maxPerWorkflow: 1,
    plannerVisible: true,
    consumes: ['comment-draft'],
    produces: [],
    costClass: 'HIGH',
    preconditions: [
      { type: 'HAS_ARTIFACT', artifactKind: 'comment-draft' },
      { type: 'PROVIDER_CONNECTED', provider: 'github' },
      { type: 'WRITE_PERMISSION_AVAILABLE', provider: 'github' },
      { type: 'EXPLICIT_CONFIRMATION' },
    ],
  },
  [Step.SUBMIT_PR_REVIEW]: {
    mutationRisk: 'WRITE',
    executionMode: 'EXPLICIT_CONFIRMATION',
    requiredContext: ['github'],
    title: 'Submit PR review',
    description: 'Submit a prepared PR review after explicit user confirmation.',
    maxPerWorkflow: 1,
    plannerVisible: true,
    consumes: ['review-draft'],
    produces: [],
    costClass: 'HIGH',
    preconditions: [
      { type: 'HAS_ARTIFACT', artifactKind: 'review-draft' },
      { type: 'PROVIDER_CONNECTED', provider: 'github' },
      { type: 'WRITE_PERMISSION_AVAILABLE', provider: 'github' },
      { type: 'EXPLICIT_CONFIRMATION' },
    ],
  },
  [Step.USER_SELECT_FINDING]: {
    mutationRisk: 'NONE',
    executionMode: 'USER_DECISION',
    requiredContext: ['github'],
    title: 'Select finding',
    description: 'Ask the user to choose which review finding to act on.',
    plannerVisible: true,
    consumes: ['pr-review'],
    produces: ['finding'],
    costClass: 'LOW',
    preconditions: [{ type: 'USER_SELECTED_TARGET' }],
  },
  [Step.USER_SELECT_FIX_TARGET]: {
    mutationRisk: 'NONE',
    executionMode: 'USER_DECISION',
    requiredContext: ['github'],
    title: 'Select fix target',
    description: 'Ask the user to choose which CI/fix target to address.',
    plannerVisible: true,
    consumes: ['ci-analysis'],
    produces: [],
    costClass: 'LOW',
    preconditions: [{ type: 'USER_SELECTED_TARGET' }],
  },
  [Step.USER_SELECT_REVIEW_EVENT]: {
    mutationRisk: 'NONE',
    executionMode: 'USER_DECISION',
    requiredContext: ['github'],
    title: 'Select review event',
    description:
      'Ask the user to choose COMMENT, APPROVE, or REQUEST_CHANGES — the model never chooses.',
    plannerVisible: true,
    consumes: ['review-draft'],
    produces: [],
    costClass: 'LOW',
    preconditions: [{ type: 'USER_SELECTED_TARGET' }],
  },
  [Step.BUILD_MULTI_REPO_CONTEXT]: {
    mutationRisk: 'NONE',
    executionMode: 'AUTO_READ',
    requiredContext: ['github'],
    title: 'Build multi-repo context',
    description:
      'Assemble a bounded multi-repository architecture context for the selected system scope.',
    plannerVisible: true,
    consumes: [],
    produces: ['multi-repo-context'],
    costClass: 'MEDIUM',
    preconditions: [
      { type: 'HAS_CONTEXT', context: 'github' },
      { type: 'PROVIDER_CONNECTED', provider: 'github' },
    ],
  },
  [Step.ANALYZE_CHANGE_IMPACT]: {
    mutationRisk: 'NONE',
    executionMode: 'AUTO_READ',
    requiredContext: ['github'],
    title: 'Analyze change impact',
    description:
      'Analyze cross-repository change impact for the bound PR/change within the selected system.',
    plannerVisible: true,
    consumes: ['multi-repo-context'],
    produces: ['change-impact', 'cross-repo-compatibility'],
    costClass: 'HIGH',
    preconditions: [
      { type: 'HAS_ARTIFACT', artifactKind: 'multi-repo-context' },
      { type: 'ARTIFACT_CURRENT', artifactKind: 'multi-repo-context' },
      { type: 'HAS_CONTEXT', context: 'github' },
    ],
  },
  [Step.TRACE_SYSTEM_FLOW]: {
    mutationRisk: 'NONE',
    executionMode: 'AUTO_READ',
    requiredContext: ['github'],
    title: 'Trace system flow',
    description:
      'Trace a typed end-to-end system flow across selected repositories (HTTP, events, services).',
    plannerVisible: true,
    consumes: ['multi-repo-context'],
    produces: ['system-flow'],
    costClass: 'HIGH',
    preconditions: [
      { type: 'HAS_ARTIFACT', artifactKind: 'multi-repo-context' },
      { type: 'ARTIFACT_CURRENT', artifactKind: 'multi-repo-context' },
    ],
  },
  [Step.COMPARE_REQUIREMENT_ACROSS_REPOS]: {
    mutationRisk: 'NONE',
    executionMode: 'AUTO_READ',
    requiredContext: ['github'],
    title: 'Compare requirement across repos',
    description:
      'Compare a Jira/requirement against selected repositories for end-to-end coverage gaps.',
    plannerVisible: true,
    consumes: ['multi-repo-context'],
    produces: ['requirement-coverage'],
    costClass: 'HIGH',
    preconditions: [
      { type: 'HAS_ARTIFACT', artifactKind: 'multi-repo-context' },
      { type: 'ARTIFACT_CURRENT', artifactKind: 'multi-repo-context' },
    ],
  },
  [Step.FIND_API_CONSUMERS]: {
    mutationRisk: 'NONE',
    executionMode: 'AUTO_READ',
    requiredContext: ['github'],
    title: 'Find API consumers',
    description:
      'Find known HTTP/API consumers of a selected operation within the selected system repositories.',
    plannerVisible: true,
    consumes: ['multi-repo-context'],
    produces: ['cross-repo-compatibility'],
    costClass: 'MEDIUM',
    preconditions: [
      { type: 'HAS_ARTIFACT', artifactKind: 'multi-repo-context' },
      { type: 'HAS_CONTEXT', context: 'github' },
    ],
  },
  [Step.FIND_EVENT_CONSUMERS]: {
    mutationRisk: 'NONE',
    executionMode: 'AUTO_READ',
    requiredContext: ['github'],
    title: 'Find event consumers',
    description:
      'Find known Kafka/event consumers of a selected topic within the selected system repositories.',
    plannerVisible: true,
    consumes: ['multi-repo-context'],
    produces: ['cross-repo-compatibility'],
    costClass: 'MEDIUM',
    preconditions: [
      { type: 'HAS_ARTIFACT', artifactKind: 'multi-repo-context' },
      { type: 'HAS_CONTEXT', context: 'github' },
    ],
  },
};

export function getCapability(type: WorkflowStepType): WorkflowCapabilityDefinition {
  return CAPABILITY_CATALOG[type];
}

export function isKnownWorkflowStepType(type: string): type is WorkflowStepType {
  return Object.prototype.hasOwnProperty.call(CAPABILITY_CATALOG, type);
}

/** Safe summaries for the planner — never includes handlers. */
export function getPlannerCapabilitySummaries(): PlannerCapabilitySummary[] {
  return (Object.keys(CAPABILITY_CATALOG) as WorkflowStepType[])
    .filter((type) => CAPABILITY_CATALOG[type].plannerVisible)
    .map((type) => {
      const cap = CAPABILITY_CATALOG[type];
      return {
        type,
        title: cap.title,
        description: cap.description,
        mutationRisk: cap.mutationRisk,
        requiredContext: [...cap.requiredContext],
        executionMode: cap.executionMode,
        consumes: [...cap.consumes],
        produces: [...cap.produces],
        costClass: cap.costClass,
      };
    });
}

export function getPlanningCapabilityDescriptions(): PlanningCapabilityDescription[] {
  return getPlannerCapabilitySummaries().map((cap) => ({
    type: cap.type,
    purpose: cap.description,
    consumes: [...(cap.consumes ?? [])],
    produces: [...(cap.produces ?? [])],
    requiredContext: [...cap.requiredContext],
    executionMode: cap.executionMode,
    costClass: cap.costClass ?? 'MEDIUM',
    mutationRisk: cap.mutationRisk,
  }));
}
