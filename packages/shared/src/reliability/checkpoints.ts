import type {
  ExecutionCheckpoint,
  ExecutionCheckpointKind,
  ExecutionCheckpointState,
} from '@project-x/types';

import { RELIABILITY_MAX_CHECKPOINTS_PER_EXECUTION } from './budgets';
import { sanitizeSafeMetadata } from './redaction';

export const CHECKPOINT_KINDS = [
  'PLANNING_COMPLETE',
  'GITHUB_CONTEXT_LOADED',
  'OPENAPI_LOADED',
  'PROJECT_MEMORY_LOADED',
  'MULTI_REPO_LOADED',
  'PR_PARSED',
  'AI_SUMMARY_COMPLETE',
  'PATCH_GENERATED',
  'JIRA_LOADED',
  'CUSTOM',
] as const satisfies ReadonlyArray<ExecutionCheckpointKind>;

export function createCheckpoint(input: {
  id: string;
  kind: ExecutionCheckpointKind;
  label: string;
  createdAt: string;
  stepId?: string;
  state?: ExecutionCheckpointState;
}): ExecutionCheckpoint {
  return {
    id: input.id,
    kind: input.kind,
    label: input.label,
    createdAt: input.createdAt,
    ...(input.stepId ? { stepId: input.stepId } : {}),
    state: sanitizeCheckpointState(input.state ?? {}),
  };
}

export function sanitizeCheckpointState(state: ExecutionCheckpointState): ExecutionCheckpointState {
  const metadata = sanitizeSafeMetadata(state as Record<string, unknown>);
  return (metadata ?? {}) as ExecutionCheckpointState;
}

export function appendCheckpoint(
  existing: ReadonlyArray<ExecutionCheckpoint>,
  checkpoint: ExecutionCheckpoint,
): ExecutionCheckpoint[] {
  const next = [...existing, checkpoint];
  if (next.length <= RELIABILITY_MAX_CHECKPOINTS_PER_EXECUTION) {
    return next;
  }
  return next.slice(next.length - RELIABILITY_MAX_CHECKPOINTS_PER_EXECUTION);
}

export function latestValidCheckpoint(
  checkpoints: ReadonlyArray<ExecutionCheckpoint>,
): ExecutionCheckpoint | undefined {
  if (checkpoints.length === 0) return undefined;
  return checkpoints[checkpoints.length - 1];
}

export function resumeFromCheckpoint(checkpoints: ReadonlyArray<ExecutionCheckpoint>):
  | {
      ok: true;
      checkpoint: ExecutionCheckpoint;
      skipCompletedThrough: string;
    }
  | {
      ok: false;
      reason: string;
    } {
  const latest = latestValidCheckpoint(checkpoints);
  if (!latest) {
    return { ok: false, reason: 'No resumable checkpoint available.' };
  }
  return {
    ok: true,
    checkpoint: latest,
    skipCompletedThrough: latest.kind,
  };
}
