import { create } from 'zustand';
import {
  analysisBindingFromParts,
  buildEngineeringContext,
  formatEngineeringContextPrompt,
  isAnalysisStale,
  type EngineeringContextBuildResult,
} from '@project-x/shared';
import type {
  AnalysisBinding,
  EngineeringContext,
  EngineeringContextBuildInput,
  HttpMethod,
  JiraIssue,
  NormalizedApiContract,
  NormalizedApiOperation,
  PageContext,
  PullRequestCISummary,
} from '@project-x/types';

import { buildApiPromptText } from '../openapi/openapi.store';

export type EngineeringSourceFlags = {
  jira: boolean;
  github: boolean;
  api: boolean;
  ci: boolean;
};

export type EngineeringSessionsInput = {
  jiraIssue?: JiraIssue | null;
  pageSnapshot?: PageContext | null;
  lastReviewContext?: PageContext | null;
  openApiContract?: NormalizedApiContract | null;
  openApiOperation?: NormalizedApiOperation | null;
  pageSelectedOperation?: {
    method: string;
    path: string;
    operationId?: string;
    summary?: string;
  } | null;
  ciSummary?: PullRequestCISummary | null;
};

type EngineeringSessionState = {
  context: EngineeringContext | null;
  lastAnalysisText: string | null;
  binding: AnalysisBinding | null;
  analyzedAt: string | null;
  lastError: string | null;
  buildFromSessions: (input: EngineeringSessionsInput) => EngineeringContextBuildResult;
  markAnalyzed: (binding: AnalysisBinding, analysisText?: string) => void;
  isStale: (currentBinding: AnalysisBinding) => boolean;
  clear: () => void;
};

export const useEngineeringSessionStore = create<EngineeringSessionState>((set, get) => ({
  context: null,
  lastAnalysisText: null,
  binding: null,
  analyzedAt: null,
  lastError: null,

  buildFromSessions: (input) => {
    const buildInput = assembleEngineeringBuildInput(input);
    const result = buildEngineeringContext(buildInput);
    if ('error' in result) {
      set({ context: null, lastError: result.message });
      return result;
    }
    set({ context: result, lastError: null });
    return result;
  },

  markAnalyzed: (binding, analysisText) => {
    set({
      binding: analysisBindingFromParts(binding),
      analyzedAt: new Date().toISOString(),
      lastAnalysisText: analysisText ?? get().lastAnalysisText,
    });
  },

  isStale: (currentBinding) => {
    const { binding } = get();
    if (!binding) {
      return false;
    }
    return isAnalysisStale(binding, currentBinding).stale;
  },

  clear: () => {
    set({
      context: null,
      lastAnalysisText: null,
      binding: null,
      analyzedAt: null,
      lastError: null,
    });
  },
}));

/** Count primary sources that can participate in alignment (≥2 required). */
export function countEngineeringSources(flags: EngineeringSourceFlags): number {
  return Number(flags.jira) + Number(flags.github) + Number(flags.api);
}

export function canAnalyzeEngineeringAlignment(flags: EngineeringSourceFlags): boolean {
  return countEngineeringSources(flags) >= 2;
}

export function detectEngineeringSourceFlags(
  input: EngineeringSessionsInput,
): EngineeringSourceFlags {
  const jira = Boolean(input.jiraIssue?.key);
  const githubCtx =
    input.lastReviewContext?.github ??
    (input.pageSnapshot?.type === 'github' ? input.pageSnapshot.github : undefined) ??
    input.pageSnapshot?.github;
  const github = Boolean(
    githubCtx?.owner &&
    githubCtx.repository &&
    githubCtx.pullRequestNumber &&
    githubCtx.pullRequestNumber > 0,
  );

  const api = Boolean(input.openApiContract && resolveApiOperation(input));

  const githubHeadSha = resolveGithubHeadSha(input);
  const ci = Boolean(
    input.ciSummary?.headSha &&
    githubHeadSha &&
    input.ciSummary.headSha.toLowerCase() === githubHeadSha.toLowerCase(),
  );

  return { jira, github, api, ci };
}

export function formatEngineeringBannerSummary(ctx: EngineeringContext): string {
  const parts: string[] = [];
  if (ctx.jira) {
    parts.push(ctx.jira.issueKey);
  }
  if (ctx.github) {
    parts.push(`PR #${ctx.github.pullRequestNumber}`);
  }
  if (ctx.api?.operation) {
    parts.push(`${ctx.api.operation.method} ${ctx.api.operation.path}`);
  } else if (ctx.api?.title) {
    parts.push(ctx.api.title);
  }
  if (ctx.ci) {
    parts.push(`CI ${ctx.ci.headSha.slice(0, 7)}`);
  }
  return parts.join(' · ');
}

export function bindingFromEngineeringContext(ctx: EngineeringContext): AnalysisBinding {
  return analysisBindingFromParts({
    jira: ctx.jira ? { issueKey: ctx.jira.issueKey, updatedAt: ctx.jira.updatedAt } : undefined,
    github: ctx.github
      ? {
          repository: `${ctx.github.repository.owner}/${ctx.github.repository.name}`,
          prNumber: ctx.github.pullRequestNumber,
          headSha: ctx.github.headSha,
        }
      : undefined,
    api: ctx.api
      ? {
          documentHash: ctx.api.documentHash,
          operationKey: ctx.api.operation
            ? `${ctx.api.operation.method}:${ctx.api.operation.path}`
            : undefined,
        }
      : undefined,
    ci: ctx.ci ? { headSha: ctx.ci.headSha } : undefined,
  });
}

export function assembleEngineeringBuildInput(
  input: EngineeringSessionsInput,
): EngineeringContextBuildInput {
  const buildInput: EngineeringContextBuildInput = {};

  if (input.jiraIssue?.key) {
    const issue = input.jiraIssue;
    buildInput.jira = {
      issueKey: issue.key,
      siteHost: issue.siteHost,
      updatedAt: issue.updatedAt,
      summary: issue.summary,
      descriptionPlainText: issue.description?.plainText,
    };
  }

  const githubCtx =
    input.lastReviewContext?.github ??
    (input.pageSnapshot?.type === 'github' ? input.pageSnapshot.github : undefined) ??
    input.pageSnapshot?.github;

  if (
    githubCtx?.owner &&
    githubCtx.repository &&
    githubCtx.pullRequestNumber &&
    githubCtx.pullRequestNumber > 0
  ) {
    const headSha = resolveGithubHeadSha(input) ?? `branch:${githubCtx.headBranch ?? 'unknown'}`;
    buildInput.github = {
      repository: { owner: githubCtx.owner, name: githubCtx.repository },
      pullRequestNumber: githubCtx.pullRequestNumber,
      headSha,
      title: githubCtx.pullRequestTitle,
      changedFiles: (githubCtx.changedFiles ?? []).map((file) => ({
        path: file.path,
        patch: file.patchExcerpt,
      })),
    };
  }

  const operation = resolveApiOperation(input);
  if (input.openApiContract && operation) {
    const contract = input.openApiContract;
    const fullOperation =
      input.openApiOperation ??
      (typeof operation.id === 'string'
        ? contract.operations.find((op) => op.id === operation.id)
        : undefined);
    const contextText = fullOperation
      ? buildApiPromptText(contract, fullOperation)
      : [
          contract.title ? `API: ${contract.title}` : null,
          `Operation: ${operation.method} ${operation.path}`,
          operation.operationId ? `operationId: ${operation.operationId}` : null,
        ]
          .filter(Boolean)
          .join('\n');

    buildInput.api = {
      documentHash: contract.documentHash,
      title: contract.title,
      operation: {
        method: normalizeHttpMethod(operation.method),
        path: operation.path,
        operationId: operation.operationId,
      },
      contextText,
    };
  }

  const githubHead = buildInput.github?.headSha;
  if (input.ciSummary?.headSha && (!githubHead || input.ciSummary.headSha === githubHead)) {
    const failed = input.ciSummary.checks.filter(
      (check) =>
        check.conclusion === 'FAILURE' ||
        check.conclusion === 'TIMED_OUT' ||
        check.conclusion === 'CANCELLED',
    );
    buildInput.ci = {
      headSha: input.ciSummary.headSha,
      status: input.ciSummary.overallStatus,
      failedChecks: failed.slice(0, 8).map((check) => ({
        name: check.name,
        conclusion: check.conclusion ?? undefined,
        htmlUrl: check.detailsUrl,
      })),
      summaryText: [
        `overall: ${input.ciSummary.overallStatus}`,
        `passed=${input.ciSummary.counts.passed} failed=${input.ciSummary.counts.failed} pending=${input.ciSummary.counts.pending}`,
        ...failed.slice(0, 5).map((c) => `fail: ${c.name} (${c.conclusion ?? 'unknown'})`),
      ].join('\n'),
    };
  }

  return buildInput;
}

export function prepareEngineeringAlignmentPrompt(ctx: EngineeringContext): {
  text: string;
  binding: AnalysisBinding;
} {
  return {
    text: formatEngineeringContextPrompt(ctx),
    binding: bindingFromEngineeringContext(ctx),
  };
}

function resolveGithubHeadSha(input: EngineeringSessionsInput): string | null {
  if (input.ciSummary?.headSha) {
    return input.ciSummary.headSha;
  }
  return null;
}

function resolveApiOperation(input: EngineeringSessionsInput): {
  method: string;
  path: string;
  operationId?: string;
  id?: string;
} | null {
  if (input.openApiOperation) {
    return input.openApiOperation;
  }
  if (input.openApiContract && input.pageSelectedOperation) {
    const pageOp = input.pageSelectedOperation;
    const matched = input.openApiContract.operations.find(
      (op) => op.method.toUpperCase() === pageOp.method.toUpperCase() && op.path === pageOp.path,
    );
    if (matched) {
      return matched;
    }
    return {
      method: pageOp.method,
      path: pageOp.path,
      operationId: pageOp.operationId,
    };
  }
  if (input.openApiContract?.operations.length === 1) {
    return input.openApiContract.operations[0] ?? null;
  }
  return null;
}

function normalizeHttpMethod(method: string): HttpMethod {
  const upper = method.toUpperCase();
  const allowed: HttpMethod[] = [
    'GET',
    'POST',
    'PUT',
    'PATCH',
    'DELETE',
    'HEAD',
    'OPTIONS',
    'TRACE',
  ];
  if ((allowed as string[]).includes(upper)) {
    return upper as HttpMethod;
  }
  return 'GET';
}
