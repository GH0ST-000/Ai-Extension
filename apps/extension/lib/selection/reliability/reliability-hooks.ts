/**
 * Best-effort Day 24 reliability hooks for the workflow engine.
 * Failures never block the local workflow session.
 */

import type {
  AuditEventType,
  ExecutionCheckpointKind,
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
  startWorkflowExecution,
} from '../../api/reliability';

let activeExecutionId: string | null = null;
let activeWorkflowId: string | null = null;

export function getActiveReliabilityExecutionId(): string | null {
  return activeExecutionId;
}

export async function reliabilityStart(input: {
  workflowId: string;
  goal: string;
  binding: WorkflowContextBinding;
  memoryVersion?: string;
  systemContextVersion?: string;
}): Promise<WorkflowExecution | null> {
  try {
    const execution = await startWorkflowExecution({
      workflowId: input.workflowId,
      goal: input.goal,
      trigger: 'user',
      contextVersion: {
        ...contextVersionFromBinding(input.binding),
        ...(input.memoryVersion ? { memoryVersion: input.memoryVersion } : {}),
        ...(input.systemContextVersion ? { systemContextVersion: input.systemContextVersion } : {}),
      },
    });
    activeExecutionId = execution.id;
    activeWorkflowId = input.workflowId;
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
): Promise<void> {
  if (!activeExecutionId) return;
  try {
    await createWorkflowCheckpoint(activeExecutionId, {
      kind,
      label,
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
    activeExecutionId = null;
    activeWorkflowId = null;
  }
}

export function reliabilityActiveWorkflowId(): string | null {
  return activeWorkflowId;
}
