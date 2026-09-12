import type {
  ExecutionCheckpoint as CheckpointRow,
  ExecutionFailure as FailureRow,
  PromptSnapshot as PromptSnapshotRow,
  WorkflowAuditEvent as AuditEventRow,
  WorkflowExecution as ExecutionRow,
} from '@prisma/client';
import {
  buildArtifactLineage,
  buildExecutionTimeline,
  computeWorkflowHealthScore,
  emptyHealthSignals,
} from '@project-x/shared';
import type {
  AiRequestAuditSnapshot,
  ArtifactLineageGraph,
  ExecutionCheckpoint,
  ExecutionContextVersion,
  ExecutionHealthSignals,
  ExecutionSnapshot,
  NormalizedExecutionFailure,
  PromptVersionRef,
  WorkflowAuditEvent,
  WorkflowExecution,
  WorkflowExecutionDetail,
  WorkflowExecutionStatus,
  WorkflowExecutionTrigger,
  ExecutionHealthBand,
} from '@project-x/types';

type ExecutionWithPrompt = ExecutionRow & {
  promptSnapshot?: PromptSnapshotRow | null;
};

export function toWorkflowExecution(row: ExecutionWithPrompt): WorkflowExecution {
  return {
    id: row.id,
    workflowId: row.workflowId,
    executionNumber: row.executionNumber,
    trigger: row.trigger as WorkflowExecutionTrigger,
    startedAt: row.startedAt.toISOString(),
    ...(row.completedAt ? { completedAt: row.completedAt.toISOString() } : {}),
    status: row.status as WorkflowExecutionStatus,
    healthScore: row.healthScore,
    healthBand: row.healthBand as ExecutionHealthBand,
    ...(row.durationMs != null ? { durationMs: row.durationMs } : {}),
    contextVersion: row.contextVersionJson as unknown as ExecutionContextVersion,
    ...(row.parentExecutionId ? { parentExecutionId: row.parentExecutionId } : {}),
    ...(row.goal ? { goal: row.goal } : {}),
    resumeAvailable: row.resumeAvailable,
    replayAvailable: row.replayAvailable,
    artifactCount: row.artifactCount,
    failureCount: row.failureCount,
    retryCount: row.retryCount,
    ...(row.promptSnapshot
      ? {
          promptVersion: {
            name: row.promptSnapshot.name,
            version: row.promptSnapshot.version,
            hash: row.promptSnapshot.hash,
            createdAt: row.promptSnapshot.createdAt.toISOString(),
            ...(row.promptSnapshot.capability ? { capability: row.promptSnapshot.capability } : {}),
            ...(row.promptSnapshot.action ? { action: row.promptSnapshot.action } : {}),
          } satisfies PromptVersionRef,
        }
      : {}),
  };
}

export function toAuditEvent(row: AuditEventRow): WorkflowAuditEvent {
  return {
    id: row.id,
    type: row.type as WorkflowAuditEvent['type'],
    timestamp: row.timestamp.toISOString(),
    executionId: row.executionId,
    workflowId: row.workflowId,
    ...(row.stepId ? { stepId: row.stepId } : {}),
    ...(row.artifactId ? { artifactId: row.artifactId } : {}),
    ...(row.message ? { message: row.message } : {}),
    ...(row.metadataJson ? { metadata: row.metadataJson as Record<string, unknown> } : {}),
  };
}

export function toCheckpoint(row: CheckpointRow): ExecutionCheckpoint {
  return {
    id: row.id,
    kind: row.kind as ExecutionCheckpoint['kind'],
    label: row.label,
    createdAt: row.createdAt.toISOString(),
    ...(row.stepId ? { stepId: row.stepId } : {}),
    state: (row.stateJson as Record<string, unknown>) ?? {},
  };
}

export function toFailure(row: FailureRow): NormalizedExecutionFailure {
  return {
    category: row.category as NormalizedExecutionFailure['category'],
    retryable: row.retryable,
    userMessage: row.userMessage,
    technicalReason: row.technicalReason,
    ...(row.stage ? { stage: row.stage } : {}),
    ...(row.code ? { code: row.code } : {}),
    ...(row.metadataJson ? { metadata: row.metadataJson as Record<string, unknown> } : {}),
  };
}

export function toExecutionDetail(
  row: ExecutionWithPrompt,
  events: AuditEventRow[],
  checkpoints: CheckpointRow[],
  failures: FailureRow[],
): WorkflowExecutionDetail {
  const auditEvents = events.map(toAuditEvent);
  const signals = (row.healthSignalsJson as ExecutionHealthSignals | null) ?? emptyHealthSignals();
  const lineage =
    (row.lineageJson as ArtifactLineageGraph | null) ?? buildArtifactLineage({ artifacts: [] });
  const aiRequests = (row.aiRequestsJson as AiRequestAuditSnapshot[] | null) ?? [];
  const snapshot = row.snapshotJson
    ? (row.snapshotJson as unknown as ExecutionSnapshot)
    : undefined;

  return {
    ...toWorkflowExecution(row),
    timeline: buildExecutionTimeline(auditEvents),
    checkpoints: checkpoints.map(toCheckpoint),
    failures: failures.map(toFailure),
    lineage,
    ...(snapshot ? { snapshot } : {}),
    aiRequests,
    events: auditEvents,
    health: computeWorkflowHealthScore(signals),
  };
}
