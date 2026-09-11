import type { WorkflowContextBinding, WorkflowContextChange } from '@project-x/types';

/**
 * Classify trusted identity / state changes between planned and current bindings.
 */
export function detectWorkflowContextChanges(
  planned: WorkflowContextBinding,
  current: WorkflowContextBinding,
): WorkflowContextChange[] {
  const changes: WorkflowContextChange[] = [];

  if (planned.github && current.github) {
    if (planned.github.headSha !== current.github.headSha) {
      changes.push({
        source: 'github',
        kind: 'HEAD_CHANGED',
        previous: planned.github.headSha,
        current: current.github.headSha,
      });
    }
  }

  if (planned.jira && current.jira) {
    if (
      planned.jira.issueKey !== current.jira.issueKey ||
      (planned.jira.updatedAt &&
        current.jira.updatedAt &&
        planned.jira.updatedAt !== current.jira.updatedAt)
    ) {
      changes.push({ source: 'jira', kind: 'ISSUE_UPDATED' });
    }
  }

  if (planned.api && current.api) {
    if (
      planned.api.documentHash !== current.api.documentHash ||
      planned.api.operationKey !== current.api.operationKey
    ) {
      changes.push({ source: 'api', kind: 'DOCUMENT_CHANGED' });
    }
  }

  if (planned.ci && current.ci) {
    if (planned.ci.headSha !== current.ci.headSha) {
      changes.push({ source: 'ci', kind: 'CHECK_STATE_CHANGED' });
    }
  }

  return changes;
}
