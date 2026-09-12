import type { ExecutionCheckpointKind, WorkflowStepType } from '@project-x/types';

/**
 * Maps a recovery checkpoint to workflow step types that are considered done.
 * Resume skips these types without re-running them.
 */
const CHECKPOINT_COMPLETED_STEP_TYPES: Record<
  ExecutionCheckpointKind,
  ReadonlyArray<WorkflowStepType>
> = {
  PLANNING_COMPLETE: [],
  GITHUB_CONTEXT_LOADED: ['BUILD_ENGINEERING_CONTEXT', 'REVIEW_PULL_REQUEST'],
  OPENAPI_LOADED: ['ANALYZE_API_CONTRACT'],
  PROJECT_MEMORY_LOADED: [],
  MULTI_REPO_LOADED: [
    'BUILD_MULTI_REPO_CONTEXT',
    'ANALYZE_CHANGE_IMPACT',
    'TRACE_SYSTEM_FLOW',
    'FIND_API_CONSUMERS',
    'FIND_EVENT_CONSUMERS',
    'COMPARE_REQUIREMENT_ACROSS_REPOS',
  ],
  PR_PARSED: ['REVIEW_PULL_REQUEST', 'BUILD_ENGINEERING_CONTEXT'],
  AI_SUMMARY_COMPLETE: [
    'SUMMARIZE_JIRA',
    'EXTRACT_ACCEPTANCE_CRITERIA',
    'ANALYZE_ENGINEERING_ALIGNMENT',
    'ANALYZE_CI_FAILURE',
  ],
  PATCH_GENERATED: ['SUGGEST_FIX', 'GENERATE_PATCH', 'PREPARE_PATCH'],
  JIRA_LOADED: ['SUMMARIZE_JIRA', 'EXTRACT_ACCEPTANCE_CRITERIA'],
  CUSTOM: [],
};

/** Ordered progression — later checkpoints imply earlier context stages are done. */
const CHECKPOINT_ORDER: ReadonlyArray<ExecutionCheckpointKind> = [
  'PLANNING_COMPLETE',
  'JIRA_LOADED',
  'GITHUB_CONTEXT_LOADED',
  'PR_PARSED',
  'OPENAPI_LOADED',
  'PROJECT_MEMORY_LOADED',
  'MULTI_REPO_LOADED',
  'AI_SUMMARY_COMPLETE',
  'PATCH_GENERATED',
  'CUSTOM',
];

export function stepTypesCompletedThroughCheckpoint(
  kind: ExecutionCheckpointKind | string,
): ReadonlyArray<WorkflowStepType> {
  const index = CHECKPOINT_ORDER.indexOf(kind as ExecutionCheckpointKind);
  if (index < 0) {
    return CHECKPOINT_COMPLETED_STEP_TYPES[kind as ExecutionCheckpointKind] ?? [];
  }

  const types = new Set<WorkflowStepType>();
  for (let i = 0; i <= index; i += 1) {
    const entry = CHECKPOINT_ORDER[i];
    if (!entry) continue;
    for (const stepType of CHECKPOINT_COMPLETED_STEP_TYPES[entry]) {
      types.add(stepType);
    }
  }
  return [...types];
}

export function shouldSkipStepForResume(input: {
  stepType: WorkflowStepType;
  skipCompletedThrough: string;
  completedStepIds?: ReadonlyArray<string>;
  stepId: string;
}): boolean {
  if (input.completedStepIds?.includes(input.stepId)) {
    return true;
  }
  return stepTypesCompletedThroughCheckpoint(input.skipCompletedThrough).includes(input.stepType);
}
