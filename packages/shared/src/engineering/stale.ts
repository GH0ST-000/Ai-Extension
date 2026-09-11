import type { AnalysisBinding } from '@project-x/types';

export type StaleAnalysisResult = {
  stale: boolean;
  changed: string[];
};

/**
 * Dependency-aware staleness check between an analysis binding and current bindings.
 */
export function isAnalysisStale(
  binding: AnalysisBinding,
  current: AnalysisBinding,
): StaleAnalysisResult {
  const changed: string[] = [];

  if (binding.jira) {
    if (!current.jira) {
      changed.push('jira');
    } else if (
      binding.jira.issueKey.toUpperCase() !== current.jira.issueKey.toUpperCase() ||
      (binding.jira.updatedAt ?? '') !== (current.jira.updatedAt ?? '')
    ) {
      changed.push('jira');
    }
  }

  if (binding.github) {
    if (!current.github) {
      changed.push('github');
    } else if (
      binding.github.repository !== current.github.repository ||
      binding.github.prNumber !== current.github.prNumber ||
      binding.github.headSha !== current.github.headSha
    ) {
      changed.push('github');
    }
  }

  if (binding.api) {
    if (!current.api) {
      changed.push('api');
    } else if (
      binding.api.documentHash !== current.api.documentHash ||
      (binding.api.operationKey ?? '') !== (current.api.operationKey ?? '')
    ) {
      changed.push('api');
    }
  }

  if (binding.ci) {
    if (!current.ci) {
      changed.push('ci');
    } else if (binding.ci.headSha !== current.ci.headSha) {
      changed.push('ci');
    } else if (binding.ci.checkIds && binding.ci.checkIds.length > 0) {
      const currentIds = new Set(current.ci.checkIds ?? []);
      const missing = binding.ci.checkIds.some((id) => !currentIds.has(id));
      const extra = (current.ci.checkIds?.length ?? 0) !== binding.ci.checkIds.length;
      if (missing || extra) {
        changed.push('ci');
      }
    }
  }

  return { stale: changed.length > 0, changed };
}

/** Build an AnalysisBinding snapshot from current identities. */
export function analysisBindingFromParts(parts: AnalysisBinding): AnalysisBinding {
  return {
    jira: parts.jira
      ? { issueKey: parts.jira.issueKey, updatedAt: parts.jira.updatedAt }
      : undefined,
    github: parts.github
      ? {
          repository: parts.github.repository,
          prNumber: parts.github.prNumber,
          headSha: parts.github.headSha,
        }
      : undefined,
    api: parts.api
      ? {
          documentHash: parts.api.documentHash,
          operationKey: parts.api.operationKey,
        }
      : undefined,
    ci: parts.ci ? { headSha: parts.ci.headSha, checkIds: parts.ci.checkIds } : undefined,
  };
}
