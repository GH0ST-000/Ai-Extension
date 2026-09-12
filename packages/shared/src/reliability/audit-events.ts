import type { AuditEventType, WorkflowAuditEvent, WorkflowAuditEventInput } from '@project-x/types';

import { RELIABILITY_MAX_AUDIT_EVENTS_PER_EXECUTION } from './budgets';
import { sha256Hex } from './hash';
import { sanitizeSafeMetadata } from './redaction';

export const AUDIT_EVENT_TYPES = [
  'WORKFLOW_STARTED',
  'WORKFLOW_COMPLETED',
  'WORKFLOW_FAILED',
  'WORKFLOW_CANCELLED',
  'PLANNING_STARTED',
  'PLANNING_COMPLETED',
  'ARTIFACT_CREATED',
  'AI_REQUEST_STARTED',
  'AI_REQUEST_COMPLETED',
  'AI_REQUEST_FAILED',
  'GITHUB_WRITE_CONFIRMED',
  'GITHUB_WRITE_COMPLETED',
  'PATCH_GENERATED',
  'PATCH_APPLIED',
  'REPLAY_STARTED',
  'REPLAY_COMPLETED',
  'RESUME_STARTED',
  'RESUME_COMPLETED',
  'CHECKPOINT_CREATED',
  'RETRY_STARTED',
  'RETRY_COMPLETED',
  'CONTEXT_LOADED',
  'FAILURE_RECORDED',
] as const satisfies ReadonlyArray<AuditEventType>;

export function isAuditEventType(value: unknown): value is AuditEventType {
  return typeof value === 'string' && (AUDIT_EVENT_TYPES as ReadonlyArray<string>).includes(value);
}

export function createAuditEvent(input: WorkflowAuditEventInput): WorkflowAuditEvent {
  return {
    id: input.id,
    type: input.type,
    timestamp: input.timestamp,
    executionId: input.executionId,
    workflowId: input.workflowId,
    ...(input.stepId ? { stepId: input.stepId } : {}),
    ...(input.artifactId ? { artifactId: input.artifactId } : {}),
    ...(input.message ? { message: input.message } : {}),
    ...(input.metadata ? { metadata: sanitizeSafeMetadata(input.metadata) } : {}),
  };
}

export function appendAuditEvent(
  existing: ReadonlyArray<WorkflowAuditEvent>,
  event: WorkflowAuditEvent,
): WorkflowAuditEvent[] {
  const next = [...existing, event];
  if (next.length <= RELIABILITY_MAX_AUDIT_EVENTS_PER_EXECUTION) {
    return next;
  }
  return next.slice(next.length - RELIABILITY_MAX_AUDIT_EVENTS_PER_EXECUTION);
}

export function auditEventFingerprint(
  event: Pick<WorkflowAuditEvent, 'type' | 'timestamp' | 'executionId'>,
): string {
  return sha256Hex(`${event.executionId}:${event.type}:${event.timestamp}`).slice(0, 16);
}
