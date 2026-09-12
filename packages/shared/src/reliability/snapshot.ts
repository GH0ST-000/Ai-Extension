import type {
  ExecutionSnapshot,
  WorkflowArtifactRef,
  WorkflowExecutionTrigger,
} from '@project-x/types';

import { RELIABILITY_MAX_SNAPSHOT_GOAL_CHARS } from './budgets';
import { redactForReliability, truncateSafeText } from './redaction';

export function buildExecutionSnapshot(input: {
  goal: string;
  constraints?: string[];
  selectedRepositories?: string[];
  workflowCapability?: string;
  checkpointIds?: string[];
  artifactRefs?: WorkflowArtifactRef[];
  trigger?: WorkflowExecutionTrigger;
}): ExecutionSnapshot {
  return {
    goal: truncateSafeText(redactForReliability(input.goal), RELIABILITY_MAX_SNAPSHOT_GOAL_CHARS),
    ...(input.constraints
      ? {
          constraints: input.constraints
            .slice(0, 20)
            .map((c) => truncateSafeText(redactForReliability(c), 200)),
        }
      : {}),
    ...(input.selectedRepositories
      ? { selectedRepositories: input.selectedRepositories.slice(0, 20) }
      : {}),
    ...(input.workflowCapability ? { workflowCapability: input.workflowCapability } : {}),
    checkpointIds: input.checkpointIds?.slice(0, 40) ?? [],
    artifactRefs: (input.artifactRefs ?? []).slice(0, 64).map((ref) => ({
      id: ref.id,
      kind: ref.kind,
      createdAt: ref.createdAt,
      ...(ref.summary ? { summary: truncateSafeText(redactForReliability(ref.summary), 200) } : {}),
      ...(ref.producedByStepId ? { producedByStepId: ref.producedByStepId } : {}),
      ...(ref.provenanceStatus ? { provenanceStatus: ref.provenanceStatus } : {}),
      ...(ref.binding ? { binding: ref.binding } : {}),
    })),
    ...(input.trigger ? { trigger: input.trigger } : {}),
  };
}
