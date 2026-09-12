import type { ExecutionTimelineEvent, WorkflowAuditEvent } from '@project-x/types';

import { RELIABILITY_MAX_TIMELINE_EVENTS } from './budgets';

const TIMELINE_LABELS: Record<string, string> = {
  WORKFLOW_STARTED: 'Workflow Started',
  WORKFLOW_COMPLETED: 'Workflow Completed',
  WORKFLOW_FAILED: 'Workflow Failed',
  WORKFLOW_CANCELLED: 'Workflow Cancelled',
  PLANNING_STARTED: 'Planning Started',
  PLANNING_COMPLETED: 'Planning Finished',
  ARTIFACT_CREATED: 'Artifact Created',
  AI_REQUEST_STARTED: 'AI Request Started',
  AI_REQUEST_COMPLETED: 'AI Stream Finished',
  AI_REQUEST_FAILED: 'AI Request Failed',
  GITHUB_WRITE_CONFIRMED: 'GitHub Write Confirmed',
  GITHUB_WRITE_COMPLETED: 'GitHub Write Completed',
  PATCH_GENERATED: 'Patch Generated',
  PATCH_APPLIED: 'Patch Applied',
  REPLAY_STARTED: 'Replay Started',
  REPLAY_COMPLETED: 'Replay Completed',
  RESUME_STARTED: 'Resume Started',
  RESUME_COMPLETED: 'Resume Completed',
  CHECKPOINT_CREATED: 'Checkpoint Created',
  RETRY_STARTED: 'Retry Started',
  RETRY_COMPLETED: 'Retry Completed',
  CONTEXT_LOADED: 'Context Loaded',
  FAILURE_RECORDED: 'Failure Recorded',
};

export function timelineLabelForAuditType(type: string): string {
  return TIMELINE_LABELS[type] ?? type;
}

export function buildExecutionTimeline(
  events: ReadonlyArray<WorkflowAuditEvent>,
): ExecutionTimelineEvent[] {
  const sorted = [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const limited =
    sorted.length > RELIABILITY_MAX_TIMELINE_EVENTS
      ? sorted.slice(sorted.length - RELIABILITY_MAX_TIMELINE_EVENTS)
      : sorted;

  return limited.map((event) => ({
    timestamp: event.timestamp,
    type: event.type,
    label: timelineLabelForAuditType(event.type),
    ...(event.message ? { message: event.message } : {}),
    ...(event.stepId ? { stepId: event.stepId } : {}),
    ...(event.artifactId ? { artifactId: event.artifactId } : {}),
  }));
}
