/**
 * Best-effort Day 24 reliability hooks for the workflow engine.
 * Failures never block the local workflow session.
 */

import type {
  AuditEventType,
  ExecutionCheckpointKind,
  ExecutionContextVersion,
  WorkflowArtifactRef,
  WorkflowContextBinding,
  WorkflowExecution,
} from '@project-x/types';

import {
  appendWorkflowAuditEvent,
  completeWorkflowExecution,
  contextVersionFromBinding,
  createWorkflowCheckpoint,
  recordWorkflowFailure,
  recordWorkflowLineage,
  resumeReliabilityExecution,
  startWorkflowExecution,
  replayReliabilityExecution,
  type ReplayExecutionResult,
} from '../../api/reliability';

let activeExecutionId: string | null = null;
let activeWorkflowId: string | null = null;
let skipCompletedThrough: string | null = null;
let resumedCompletedStepIds: string[] = [];
let lastExecutionId: string | null = null;

export function getActiveReliabilityExecutionId(): string | null {
  return activeExecutionId;
}

export function getLastReliabilityExecutionId(): string | null {
  return lastExecutionId ?? activeExecutionId;
}

export function getReliabilitySkipCompletedThrough(): string | null {
  return skipCompletedThrough;
}

export function getResumedCompletedStepIds(): ReadonlyArray<string> {
  return resumedCompletedStepIds;
}

export function clearReliabilityResumeSkip(): void {
  skipCompletedThrough = null;
  resumedCompletedStepIds = [];
}

export function adoptReliabilityExecution(input: {
  executionId: string;
  workflowId: string;
  skipCompletedThrough?: string;
  completedStepIds?: ReadonlyArray<string>;
}): void {
  activeExecutionId = input.executionId;
  activeWorkflowId = input.workflowId;
  lastExecutionId = input.executionId;
  skipCompletedThrough = input.skipCompletedThrough ?? null;
  resumedCompletedStepIds = input.completedStepIds ? [...input.completedStepIds] : [];
}

export async function reliabilityStart(input: {
  workflowId: string;
  goal: string;
  binding: WorkflowContextBinding;
  memoryVersion?: string;
  systemContextVersion?: string;
  openapiHash?: string;
  jiraUpdatedAt?: string;
  trigger?: 'user' | 'retry' | 'resume' | 'replay';
  parentExecutionId?: string;
  promptName?: string;
  promptBody?: string;
}): Promise<WorkflowExecution | null> {
  try {
    const execution = await startWorkflowExecution({
      workflowId: input.workflowId,
      goal: input.goal,
      trigger: input.trigger ?? 'user',
      ...(input.parentExecutionId ? { parentExecutionId: input.parentExecutionId } : {}),
      ...(input.promptName ? { promptName: input.promptName } : {}),
      ...(input.promptBody ? { promptBody: input.promptBody } : {}),
      contextVersion: {
        ...contextVersionFromBinding(input.binding),
        ...(input.memoryVersion ? { memoryVersion: input.memoryVersion } : {}),
        ...(input.systemContextVersion ? { systemContextVersion: input.systemContextVersion } : {}),
        ...(input.openapiHash ? { openapiHash: input.openapiHash } : {}),
        ...(input.jiraUpdatedAt ? { jiraUpdatedAt: input.jiraUpdatedAt } : {}),
      },
    });
    activeExecutionId = execution.id;
    activeWorkflowId = input.workflowId;
    lastExecutionId = execution.id;
    skipCompletedThrough = null;
    resumedCompletedStepIds = [];
    return execution;
  } catch {
    return null;
  }
}

export async function reliabilityEvent(
  type: AuditEventType,
  extras?: {
    stepId?: string;
    artifactId?: string;
    message?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  if (!activeExecutionId) return;
  try {
    await appendWorkflowAuditEvent(activeExecutionId, {
      type,
      ...(extras?.stepId ? { stepId: extras.stepId } : {}),
      ...(extras?.artifactId ? { artifactId: extras.artifactId } : {}),
      ...(extras?.message ? { message: extras.message } : {}),
      ...(extras?.metadata ? { metadata: extras.metadata } : {}),
    });
  } catch {
    // best-effort
  }
}

export async function reliabilityCheckpoint(
  kind: ExecutionCheckpointKind,
  label: string,
  state?: Record<string, unknown>,
  stepId?: string,
): Promise<void> {
  if (!activeExecutionId) return;
  try {
    await createWorkflowCheckpoint(activeExecutionId, {
      kind,
      label,
      ...(stepId ? { stepId } : {}),
      ...(state ? { state } : {}),
    });
  } catch {
    // best-effort
  }
}

export async function reliabilityFail(input: {
  code?: string;
  message?: string;
  stage?: string;
}): Promise<void> {
  if (!activeExecutionId) return;
  try {
    await recordWorkflowFailure(activeExecutionId, input);
  } catch {
    // best-effort
  }
}

export async function reliabilityLineage(artifacts: WorkflowArtifactRef[]): Promise<void> {
  if (!activeExecutionId) return;
  try {
    const list = Object.values(artifacts);
    let parent: string | undefined;
    await recordWorkflowLineage(activeExecutionId, {
      artifacts: list.map((artifact, index) => {
        const node = {
          id: artifact.id,
          kind: artifact.kind,
          ...(artifact.summary ? { summary: artifact.summary } : {}),
          ...(artifact.producedByStepId ? { producedByStepId: artifact.producedByStepId } : {}),
          ...(index > 0 && parent ? { parentArtifactId: parent } : {}),
        };
        parent = artifact.id;
        return node;
      }),
    });
  } catch {
    // best-effort
  }
}

export async function reliabilityComplete(
  status: 'completed' | 'failed' | 'cancelled' | 'stale',
  artifacts?: Record<string, WorkflowArtifactRef>,
): Promise<void> {
  if (!activeExecutionId) return;
  try {
    if (artifacts) {
      await reliabilityLineage(Object.values(artifacts));
    }
    await completeWorkflowExecution(activeExecutionId, {
      status,
      ...(artifacts ? { snapshotArtifacts: Object.values(artifacts) } : {}),
    });
  } catch {
    // best-effort
  } finally {
    // Keep lastExecutionId for resume/replay after completion.
    activeExecutionId = null;
    activeWorkflowId = null;
    skipCompletedThrough = null;
    resumedCompletedStepIds = [];
  }
}

export async function reliabilityResumeFromServer(executionId: string): Promise<{
  execution: WorkflowExecution;
  skipCompletedThrough: string;
  completedStepIds: string[];
} | null> {
  try {
    const result = await resumeReliabilityExecution(executionId);
    const completedStepIds = Array.isArray(result.checkpoint.state.completedStepIds)
      ? (result.checkpoint.state.completedStepIds as string[])
      : [];
    adoptReliabilityExecution({
      executionId: result.execution.id,
      workflowId: result.execution.workflowId,
      skipCompletedThrough: result.skipCompletedThrough,
      completedStepIds,
    });
    await reliabilityEvent('RESUME_STARTED', {
      message: `Resuming from ${result.skipCompletedThrough}`,
      metadata: { parentExecutionId: executionId },
    });
    return {
      execution: result.execution,
      skipCompletedThrough: result.skipCompletedThrough,
      completedStepIds,
    };
  } catch {
    return null;
  }
}

export async function reliabilityReplayFromServer(
  executionId: string,
  currentContext?: ExecutionContextVersion,
): Promise<ReplayExecutionResult | null> {
  try {
    const result = await replayReliabilityExecution(executionId, currentContext);
    adoptReliabilityExecution({
      executionId: result.execution.id,
      workflowId: result.execution.workflowId,
    });
    await reliabilityEvent('REPLAY_STARTED', {
      message: result.drift.hasDrift
        ? 'Replay with context drift — writes still require confirmation'
        : 'Replay started — writes still require confirmation',
      metadata: {
        parentExecutionId: executionId,
        hasDrift: result.drift.hasDrift,
        requiresWriteConfirmation: true,
      },
    });
    return result;
  } catch {
    return null;
  }
}

export function reliabilityActiveWorkflowId(): string | null {
  return activeWorkflowId;
}
