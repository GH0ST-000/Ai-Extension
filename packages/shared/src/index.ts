export { findJiraIssueKeysInText, detectJiraKeysInPrSignals } from './jira/jira-key-match';
export {
  validateOpenApiFetchUrl,
  sanitizeOpenApiDocumentUrl,
  isPrivateOrReservedIp,
  isIPv4,
  isIPv6,
} from './openapi/safe-url';
export type { SafeUrlResult, SafeUrlRejectReason } from './openapi/safe-url';
export { findOperation, buildOperationAiContext } from './openapi/operation-context';
export { generateApiExample } from './openapi/example';
export { isOpenApiSpecPath, filterOpenApiSpecPaths } from './openapi/spec-path';

export {
  ENGINEERING_MAX_JIRA_CHARS,
  ENGINEERING_MAX_ACCEPTANCE_CRITERIA,
  ENGINEERING_MAX_PR_FILES,
  ENGINEERING_MAX_DIFF_CHARS,
  ENGINEERING_MAX_FINDINGS,
  ENGINEERING_MAX_API_CONTEXT_CHARS,
  ENGINEERING_MAX_CI_CHARS,
  ENGINEERING_MAX_TOTAL_PROMPT_CHARS,
  ENGINEERING_MAX_EVIDENCE_EXCERPT,
} from './engineering/budgets';
export { extractAcceptanceCriteriaFromPlainText } from './engineering/extract-criteria';
export {
  tokenizeForRelevance,
  scoreFileRelevance,
  buildCriteriaTokenSet,
  buildApiPathTokenSet,
} from './engineering/relevance';
export { buildEngineeringContext, buildContextId } from './engineering/build-context';
export type { EngineeringContextBuildResult } from './engineering/build-context';
export { formatEngineeringContextPrompt } from './engineering/prompt-text';
export { validateEngineeringEvidence } from './engineering/evidence';
export { validateEngineeringAlignmentAnalysis } from './engineering/validate-analysis';
export type { ValidateAnalysisResult } from './engineering/validate-analysis';
export { isAnalysisStale, analysisBindingFromParts } from './engineering/stale';
export type { StaleAnalysisResult } from './engineering/stale';

export {
  CAPABILITY_CATALOG,
  getCapability,
  getPlannerCapabilitySummaries,
  getPlanningCapabilityDescriptions,
  isKnownWorkflowStepType,
} from './workflow/capabilities';
export type { WorkflowCapabilityDefinition } from './workflow/capabilities';
export { WORKFLOW_POLICY, assertCapabilityAllowed, normalizeStepSafety } from './workflow/policy';
export { validateDeveloperWorkflowPlan } from './workflow/validate-plan';
export type { ValidatePlanOptions, WorkflowAvailableContext } from './workflow/validate-plan';
export {
  evaluateWorkflowCondition,
  evaluateWorkflowConditionFromFacts,
  conditionStateFromFacts,
} from './workflow/conditions';
export type { WorkflowConditionState } from './workflow/conditions';
export { isWorkflowBindingStale } from './workflow/stale';
export type { StaleWorkflowBindingResult } from './workflow/stale';
export { formatCapabilityCatalogForPlanner } from './workflow/prompt-catalog';
export {
  normalizeAgentGoal,
  goalMentionsMultipleJiraIssues,
  constraintsForbidWrites,
  constraintsForbidPatchApply,
  constraintsForbidReviewSubmission,
  isUnsafeConstraintAttempt,
} from './workflow/goal-normalize';
export type { NormalizeAgentGoalInput } from './workflow/goal-normalize';
export {
  buildPlanningContext,
  formatPlanningContextForPrompt,
  defaultPlanningPolicy,
  defaultPlanningLimits,
  inferPlanningConfidence,
} from './workflow/planning-context';
export type { BuildPlanningContextInput } from './workflow/planning-context';
export {
  WORKFLOW_FACT_NAMES,
  isKnownWorkflowFactName,
  createWorkflowFact,
  upsertWorkflowFacts,
  sanitizeWorkflowFacts,
  getFactValue,
  factAsBoolean,
  conditionTypeToFactName,
} from './workflow/facts';
export {
  isCompletionCriterionSatisfied,
  evaluateCompletionCriteria,
  defaultCompletionCriteriaForOutcome,
  buildWorkflowGoalOutcome,
  isKnownCompletionCriterionType,
} from './workflow/completion';
export type { BuildGoalOutcomeInput } from './workflow/completion';
export {
  createArtifactProvenance,
  annotateArtifact,
  markArtifactsStaleForBindingChange,
  consumeWorkflowArtifact,
  findCurrentArtifact,
} from './workflow/provenance';
export type { ConsumeArtifactResult } from './workflow/provenance';
export { evaluatePrecondition, evaluateCapabilityPreconditions } from './workflow/preconditions';
export type { PreconditionRuntime, PreconditionEvalResult } from './workflow/preconditions';
export {
  buildPlanRevision,
  applyApprovedRevision,
  listCompletedStepIds,
  listRemainingStepIds,
  revisionIntroducesWrite,
} from './workflow/revision';
export {
  createWorkflowBudget,
  incrementBudget,
  isBudgetExceeded,
  wouldExceedBudget,
  budgetExceededMessage,
} from './workflow/budget';
export type { BudgetCounter } from './workflow/budget';
export {
  validatePlanAgainstGoalConstraints,
  validateCompletionCriteriaAgainstPlan,
  parseCompletionCriteria,
} from './workflow/goal-constraints';
export { detectWorkflowContextChanges } from './workflow/context-change';

export { normalizeRepositoryPath } from './ci-fix/normalize-path';
export {
  extractPathsFromText,
  resolveCIFixTargets,
  selectPrimaryCIFixTarget,
} from './ci-fix/resolve-targets';
export type { ResolveCIFixTargetsInput } from './ci-fix/resolve-targets';
export { buildCIFailureSignature, compareFailureSignatures } from './ci-fix/failure-signature';
export {
  matchCheckOnNewHead,
  verifyCIFixAgainstSummary,
  verificationToSessionStatus,
} from './ci-fix/verify-fix';
export type { VerifyCIFixInput } from './ci-fix/verify-fix';

export const APP_NAME = 'Project X' as const;

export const SERVICE_NAMES = {
  api: 'api',
  dashboard: 'dashboard',
  extension: 'extension',
} as const;

export type ServiceName = (typeof SERVICE_NAMES)[keyof typeof SERVICE_NAMES];

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  return 'Unknown error';
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
