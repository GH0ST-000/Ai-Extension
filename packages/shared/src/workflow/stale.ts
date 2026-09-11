import type { WorkflowContextBinding } from '@project-x/types';

export type StaleWorkflowBindingResult = {
  stale: boolean;
  changed: string[];
};

/**
 * Dependency-aware staleness check between planned and current workflow bindings.
 * Mirrors isAnalysisStale for AnalysisBinding.
 */
export function isWorkflowBindingStale(
  planned: WorkflowContextBinding,
  current: WorkflowContextBinding,
): StaleWorkflowBindingResult {
  const changed: string[] = [];

  if (planned.jira) {
    if (!current.jira) {
      changed.push('jira');
    } else if (
      planned.jira.issueKey.toUpperCase() !== current.jira.issueKey.toUpperCase() ||
      (planned.jira.updatedAt ?? '') !== (current.jira.updatedAt ?? '')
    ) {
      changed.push('jira');
    }
  }

  if (planned.github) {
    if (!current.github) {
      changed.push('github');
    } else if (
      planned.github.repository !== current.github.repository ||
      planned.github.prNumber !== current.github.prNumber ||
      planned.github.headSha !== current.github.headSha
    ) {
      changed.push('github');
    }
  }

  if (planned.api) {
    if (!current.api) {
      changed.push('api');
    } else if (
      planned.api.documentHash !== current.api.documentHash ||
      (planned.api.operationKey ?? '') !== (current.api.operationKey ?? '')
    ) {
      changed.push('api');
    }
  }

  if (planned.ci) {
    if (!current.ci) {
      changed.push('ci');
    } else if (planned.ci.headSha !== current.ci.headSha) {
      changed.push('ci');
    } else if (planned.ci.checkIds && planned.ci.checkIds.length > 0) {
      const currentIds = new Set(current.ci.checkIds ?? []);
      const missing = planned.ci.checkIds.some((id) => !currentIds.has(id));
      const extra = (current.ci.checkIds?.length ?? 0) !== planned.ci.checkIds.length;
      if (missing || extra) {
        changed.push('ci');
      }
    }
  }

  return { stale: changed.length > 0, changed };
}
