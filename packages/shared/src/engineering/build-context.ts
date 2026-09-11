import type {
  AcceptanceCriterion,
  EngineeringChangedFile,
  EngineeringContext,
  EngineeringContextBuildInput,
  EngineeringContextSource,
  EngineeringErrorCode,
  EngineeringFindingSummary,
} from '@project-x/types';
import {
  ENGINEERING_MAX_ACCEPTANCE_CRITERIA,
  ENGINEERING_MAX_API_CONTEXT_CHARS,
  ENGINEERING_MAX_CI_CHARS,
  ENGINEERING_MAX_DIFF_CHARS,
  ENGINEERING_MAX_FINDINGS,
  ENGINEERING_MAX_JIRA_CHARS,
  ENGINEERING_MAX_PR_FILES,
} from '@project-x/types';

import { extractAcceptanceCriteriaFromPlainText } from './extract-criteria';
import { buildApiPathTokenSet, buildCriteriaTokenSet, scoreFileRelevance } from './relevance';

export type EngineeringContextBuildResult =
  EngineeringContext | { error: EngineeringErrorCode; message: string };

/**
 * Pure, deterministic Engineering Context builder.
 * No network I/O — operates only on already-normalized input slices.
 */
export function buildEngineeringContext(
  input: EngineeringContextBuildInput,
): EngineeringContextBuildResult {
  const hasJira = Boolean(input.jira);
  const hasGithub = Boolean(input.github);
  const hasApi = Boolean(input.api);
  const primaryCount = Number(hasJira) + Number(hasGithub) + Number(hasApi);

  if (primaryCount < 2) {
    return {
      error: 'ENGINEERING_CONTEXT_INSUFFICIENT',
      message: 'Select at least two related engineering contexts to compare.',
    };
  }

  const truncationReasons: string[] = [];
  const includedSources: EngineeringContextSource[] = [];

  let jiraSlice: EngineeringContext['jira'];
  if (input.jira) {
    includedSources.push('jira');
    const built = buildJiraSlice(input.jira, truncationReasons);
    jiraSlice = built;
  }

  let githubSlice: EngineeringContext['github'];
  if (input.github) {
    includedSources.push('github-pr');
    const criteriaForRelevance = [
      ...(jiraSlice?.explicitAcceptanceCriteria ?? []),
      ...(jiraSlice?.inferredAcceptanceCriteria ?? []),
    ];
    const built = buildGithubSlice(
      input.github,
      criteriaForRelevance,
      input.api?.operation?.path,
      input.api?.operation?.operationId,
      truncationReasons,
    );
    githubSlice = built;
    if (built.findings && built.findings.length > 0) {
      includedSources.push('github-review');
    } else if (built.reviewReport) {
      includedSources.push('github-review');
    }
  }

  let apiSlice: EngineeringContext['api'];
  if (input.api) {
    includedSources.push('openapi');
    apiSlice = buildApiSlice(input.api, truncationReasons);
  }

  let ciSlice: EngineeringContext['ci'];
  if (input.ci) {
    if (input.github && input.ci.headSha !== input.github.headSha) {
      truncationReasons.push('ci-omitted-head-sha-mismatch');
    } else {
      includedSources.push('ci');
      ciSlice = buildCiSlice(input.ci, truncationReasons);
    }
  }

  const createdAt = input.createdAt ?? new Date().toISOString();
  const id = buildContextId({
    jira: jiraSlice ? { issueKey: jiraSlice.issueKey, updatedAt: jiraSlice.updatedAt } : undefined,
    github: githubSlice
      ? {
          owner: githubSlice.repository.owner,
          name: githubSlice.repository.name,
          pr: githubSlice.pullRequestNumber,
          headSha: githubSlice.headSha,
        }
      : undefined,
    api: apiSlice
      ? {
          documentHash: apiSlice.documentHash,
          method: apiSlice.operation?.method,
          path: apiSlice.operation?.path,
          operationId: apiSlice.operation?.operationId,
        }
      : undefined,
    ci: ciSlice ? { headSha: ciSlice.headSha } : undefined,
  });

  return {
    id,
    createdAt,
    jira: jiraSlice,
    github: githubSlice,
    api: apiSlice,
    ci: ciSlice,
    scope: {
      partial: truncationReasons.length > 0,
      truncationReasons,
      includedSources: dedupeSources(includedSources),
    },
  };
}

function buildJiraSlice(
  jira: NonNullable<EngineeringContextBuildInput['jira']>,
  truncationReasons: string[],
): NonNullable<EngineeringContext['jira']> {
  let explicit =
    jira.explicitAcceptanceCriteria?.slice(0, ENGINEERING_MAX_ACCEPTANCE_CRITERIA) ?? [];
  if (explicit.length === 0 && jira.descriptionPlainText && jira.descriptionPlainText.trim()) {
    explicit = extractAcceptanceCriteriaFromPlainText(jira.descriptionPlainText);
  }
  if ((jira.explicitAcceptanceCriteria?.length ?? 0) > ENGINEERING_MAX_ACCEPTANCE_CRITERIA) {
    truncationReasons.push('jira-acceptance-criteria-capped');
  }

  const inferred = jira.inferredAcceptanceCriteria?.slice(
    0,
    Math.max(0, ENGINEERING_MAX_ACCEPTANCE_CRITERIA - explicit.length),
  );
  if ((jira.inferredAcceptanceCriteria?.length ?? 0) > (inferred?.length ?? 0)) {
    truncationReasons.push('jira-inferred-criteria-capped');
  }

  let descriptionExcerpt: string | undefined;
  let truncated = false;
  if (jira.descriptionPlainText) {
    const capped = truncateChars(jira.descriptionPlainText, ENGINEERING_MAX_JIRA_CHARS);
    descriptionExcerpt = capped.text || undefined;
    truncated = capped.truncated;
    if (capped.truncated) {
      truncationReasons.push('jira-description-truncated');
    }
  }

  return {
    issueKey: jira.issueKey,
    siteHost: jira.siteHost,
    updatedAt: jira.updatedAt,
    summary: jira.summary,
    descriptionExcerpt,
    explicitAcceptanceCriteria: explicit,
    inferredAcceptanceCriteria: inferred && inferred.length > 0 ? inferred : undefined,
    truncated: truncated || undefined,
  };
}

function buildGithubSlice(
  github: NonNullable<EngineeringContextBuildInput['github']>,
  criteria: AcceptanceCriterion[],
  apiPath: string | undefined,
  operationId: string | undefined,
  truncationReasons: string[],
): NonNullable<EngineeringContext['github']> {
  const criteriaTokens = buildCriteriaTokenSet(criteria);
  const apiTokens = buildApiPathTokenSet(apiPath, operationId);

  const scored = github.changedFiles.map((file) => {
    const { score, relevance } = scoreFileRelevance(file.path, criteriaTokens, apiTokens);
    return { file, score, relevance };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.file.path.localeCompare(b.file.path);
  });

  const selected = scored.slice(0, ENGINEERING_MAX_PR_FILES);
  if (scored.length > ENGINEERING_MAX_PR_FILES) {
    truncationReasons.push(`pr-files-capped:${scored.length - ENGINEERING_MAX_PR_FILES}-omitted`);
  }

  let remainingDiff = ENGINEERING_MAX_DIFF_CHARS;
  const changedFiles: EngineeringChangedFile[] = [];
  for (const item of selected) {
    let patchExcerpt: string | undefined;
    if (item.file.patch && remainingDiff > 0) {
      const capped = truncateChars(item.file.patch, remainingDiff);
      patchExcerpt = capped.text || undefined;
      remainingDiff -= capped.text.length;
      if (capped.truncated || remainingDiff === 0) {
        truncationReasons.push('pr-diff-truncated');
      }
    } else if (item.file.patch && remainingDiff <= 0) {
      truncationReasons.push('pr-diff-budget-exhausted');
    }
    changedFiles.push({
      path: item.file.path,
      patchExcerpt,
      relevance: item.relevance,
    });
  }

  let findings: EngineeringFindingSummary[] | undefined;
  if (github.findings && github.findings.length > 0) {
    findings = github.findings.slice(0, ENGINEERING_MAX_FINDINGS);
    if (github.findings.length > ENGINEERING_MAX_FINDINGS) {
      truncationReasons.push('pr-findings-capped');
    }
  }

  return {
    repository: {
      owner: github.repository.owner,
      name: github.repository.name,
    },
    pullRequestNumber: github.pullRequestNumber,
    headSha: github.headSha,
    baseSha: github.baseSha,
    title: github.title,
    changedFiles,
    reviewReport: github.reviewReport,
    findings,
  };
}

function buildApiSlice(
  api: NonNullable<EngineeringContextBuildInput['api']>,
  truncationReasons: string[],
): NonNullable<EngineeringContext['api']> {
  let contextExcerpt: string | undefined;
  if (api.contextText) {
    const capped = truncateChars(api.contextText, ENGINEERING_MAX_API_CONTEXT_CHARS);
    contextExcerpt = capped.text || undefined;
    if (capped.truncated) {
      truncationReasons.push('api-context-truncated');
    }
  }

  let contractFindings = api.contractFindings;
  if (contractFindings && contractFindings.length > ENGINEERING_MAX_FINDINGS) {
    contractFindings = contractFindings.slice(0, ENGINEERING_MAX_FINDINGS);
    truncationReasons.push('api-findings-capped');
  }

  return {
    documentHash: api.documentHash,
    title: api.title,
    operation: api.operation
      ? {
          method: api.operation.method,
          path: api.operation.path,
          operationId: api.operation.operationId,
        }
      : undefined,
    contextExcerpt,
    contractFindings,
    contractDiff: api.contractDiff,
  };
}

function buildCiSlice(
  ci: NonNullable<EngineeringContextBuildInput['ci']>,
  truncationReasons: string[],
): NonNullable<EngineeringContext['ci']> {
  let summaryExcerpt: string | undefined;
  if (ci.summaryText) {
    const capped = truncateChars(ci.summaryText, ENGINEERING_MAX_CI_CHARS);
    summaryExcerpt = capped.text || undefined;
    if (capped.truncated) {
      truncationReasons.push('ci-summary-truncated');
    }
  }

  return {
    headSha: ci.headSha,
    status: ci.status,
    failedChecks: ci.failedChecks,
    summaryExcerpt,
  };
}

function truncateChars(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) {
    return { text, truncated: false };
  }
  if (max <= 1) {
    return { text: text.slice(0, max), truncated: true };
  }
  return { text: `${text.slice(0, max - 1)}…`, truncated: true };
}

/** Stable non-crypto identity hash for context id. */
export function buildContextId(parts: {
  jira?: { issueKey: string; updatedAt?: string };
  github?: { owner: string; name: string; pr: number; headSha: string };
  api?: {
    documentHash: string;
    method?: string;
    path?: string;
    operationId?: string;
  };
  ci?: { headSha: string };
}): string {
  const chunks: string[] = [];
  if (parts.jira) {
    chunks.push(`j:${parts.jira.issueKey}@${parts.jira.updatedAt ?? ''}`);
  }
  if (parts.github) {
    chunks.push(
      `g:${parts.github.owner}/${parts.github.name}#${parts.github.pr}@${parts.github.headSha}`,
    );
  }
  if (parts.api) {
    const op =
      parts.api.operationId ??
      (parts.api.method && parts.api.path ? `${parts.api.method} ${parts.api.path}` : '');
    chunks.push(`a:${parts.api.documentHash}|${op}`);
  }
  if (parts.ci) {
    chunks.push(`c:${parts.ci.headSha}`);
  }
  const material = chunks.join('|');
  return `eng-${fnv1aHex(material)}`;
}

function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // unsigned 32-bit hex
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function dedupeSources(sources: EngineeringContextSource[]): EngineeringContextSource[] {
  const seen = new Set<EngineeringContextSource>();
  const out: EngineeringContextSource[] = [];
  for (const s of sources) {
    if (seen.has(s)) {
      continue;
    }
    seen.add(s);
    out.push(s);
  }
  return out;
}
