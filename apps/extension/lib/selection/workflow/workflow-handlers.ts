import { AIAction, type WorkflowArtifactKind, type WorkflowStepType } from '@project-x/types';
import { WorkflowStepType as Step } from '@project-x/types';

import {
  assembleEngineeringBuildInput,
  prepareEngineeringAlignmentPrompt,
  useEngineeringSessionStore,
  type EngineeringSessionsInput,
} from '../engineering/engineering.store';
import { useGithubCiStore } from '../ci';
import { useCIFixSessionStore } from '../ci/fix/ci-fix.store';
import { githubChangeFromSessions, useMultiRepoStore } from '../multi-repo';
import { usePatchApplyStore } from '../patch-apply/patch-apply.store';
import { useGithubReviewDraftStore } from '../review-draft';

export type WorkflowOpenPanel = 'patch' | 'review' | 'comment' | 'multi-repo';

export type WorkflowHandlerResult =
  | { ok: true; summary?: string; artifactKind?: WorkflowArtifactKind; showPanel?: 'multi-repo' }
  | {
      ok: true;
      needsAiAction: AIAction;
      text: string;
      summary?: string;
    }
  | {
      ok: true;
      needsConfirmation: true;
      openPanel: Exclude<WorkflowOpenPanel, 'multi-repo'>;
      summary?: string;
    }
  | {
      ok: true;
      needsUserInput: true;
      options: { id: string; label: string }[];
      prompt: string;
      summary?: string;
    }
  | { ok: false; message: string; retryable?: boolean };

export type WorkflowHandlerContext = {
  sessions: EngineeringSessionsInput;
  findingOptions?: { id: string; label: string }[];
  fixTargetOptions?: { id: string; label: string }[];
};

/**
 * Thin capability handlers — never call Octokit / write APIs directly.
 * Write steps only surface confirmation + which Day 13/14 panel to open.
 * Day 23 multi-repo steps are READ-ONLY (artifact refs / panel only).
 */
export function runWorkflowStepHandler(
  type: WorkflowStepType,
  ctx: WorkflowHandlerContext,
): WorkflowHandlerResult {
  switch (type) {
    case Step.BUILD_ENGINEERING_CONTEXT: {
      const result = useEngineeringSessionStore.getState().buildFromSessions(ctx.sessions);
      if ('error' in result) {
        return { ok: false, message: result.message, retryable: true };
      }
      return {
        ok: true,
        summary: 'Engineering context built',
        artifactKind: 'engineering-context',
      };
    }

    case Step.ANALYZE_ENGINEERING_ALIGNMENT: {
      const built = useEngineeringSessionStore.getState().buildFromSessions(ctx.sessions);
      if ('error' in built) {
        return { ok: false, message: built.message, retryable: true };
      }
      const { text, binding } = prepareEngineeringAlignmentPrompt(built);
      useEngineeringSessionStore.getState().markAnalyzed(binding, text);
      return {
        ok: true,
        needsAiAction: AIAction.ANALYZE_ENGINEERING_ALIGNMENT,
        text,
        summary: 'Alignment analysis requested',
      };
    }

    case Step.SUMMARIZE_JIRA:
      return {
        ok: true,
        needsAiAction: AIAction.SUMMARIZE_JIRA_ISSUE,
        text: buildJiraPromptText(ctx.sessions),
        summary: 'Jira summary requested',
      };

    case Step.EXTRACT_ACCEPTANCE_CRITERIA:
      return {
        ok: true,
        needsAiAction: AIAction.EXTRACT_ACCEPTANCE_CRITERIA,
        text: buildJiraPromptText(ctx.sessions),
        summary: 'Acceptance criteria extraction requested',
      };

    case Step.REVIEW_PULL_REQUEST:
      return {
        ok: true,
        needsAiAction: AIAction.REVIEW_ENTIRE_PR,
        text: buildGithubPromptText(ctx.sessions),
        summary: 'PR review requested',
      };

    case Step.ANALYZE_API_CONTRACT:
      return {
        ok: true,
        needsAiAction: AIAction.ANALYZE_API_CONTRACT,
        text: buildApiPromptText(ctx.sessions),
        summary: 'API contract analysis requested',
      };

    case Step.ANALYZE_CI_FAILURE:
      return {
        ok: true,
        needsAiAction: AIAction.ANALYZE_CI_FAILURE,
        text: buildCiPromptText(ctx.sessions),
        summary: 'CI failure analysis requested',
      };

    case Step.SUGGEST_FIX:
    case Step.GENERATE_PATCH:
      return {
        ok: true,
        needsAiAction: AIAction.SUGGEST_FIX,
        text: buildGithubPromptText(ctx.sessions),
        summary: 'Fix suggestion requested',
      };

    case Step.PREPARE_PATCH:
      usePatchApplyStore.getState().setPhase('idle');
      return {
        ok: true,
        summary: 'Patch prepared for Apply Fix confirmation',
        artifactKind: 'prepared-patch',
      };

    case Step.APPLY_PATCH:
      usePatchApplyStore.getState().setPhase('idle');
      return {
        ok: true,
        needsConfirmation: true,
        openPanel: 'patch',
        summary: 'Waiting for Apply Fix confirmation',
      };

    case Step.GENERATE_PR_COMMENT:
      return {
        ok: true,
        summary: 'PR comment draft ready',
        artifactKind: 'comment-draft',
      };

    case Step.SUBMIT_PR_COMMENT:
      return {
        ok: true,
        needsConfirmation: true,
        openPanel: 'comment',
        summary: 'Waiting for comment confirmation',
      };

    case Step.CREATE_REVIEW_DRAFT:
      useGithubReviewDraftStore.getState().setPhase('editing');
      return {
        ok: true,
        summary: 'Review draft ready',
        artifactKind: 'review-draft',
      };

    case Step.SUBMIT_PR_REVIEW:
      useGithubReviewDraftStore.getState().setPhase('editing');
      return {
        ok: true,
        needsConfirmation: true,
        openPanel: 'review',
        summary: 'Waiting for review confirmation',
      };

    case Step.USER_SELECT_REVIEW_EVENT:
      return {
        ok: true,
        needsUserInput: true,
        options: [
          { id: 'COMMENT', label: 'Comment' },
          { id: 'APPROVE', label: 'Approve' },
          { id: 'REQUEST_CHANGES', label: 'Request changes' },
        ],
        prompt: 'Select the review event — Project X never chooses this for you',
        summary: 'Awaiting review event selection',
      };

    case Step.USER_SELECT_FINDING: {
      const options = ctx.findingOptions ?? [];
      if (options.length === 0) {
        return {
          ok: false,
          message: 'No findings available to select',
          retryable: true,
        };
      }
      return {
        ok: true,
        needsUserInput: true,
        options,
        prompt: 'Select a finding to continue',
        summary: 'Awaiting finding selection',
      };
    }

    case Step.USER_SELECT_FIX_TARGET: {
      const options = ctx.fixTargetOptions ?? [];
      if (options.length === 0) {
        return {
          ok: false,
          message: 'No fix targets available to select',
          retryable: true,
        };
      }
      return {
        ok: true,
        needsUserInput: true,
        options,
        prompt: 'Select a fix target to continue',
        summary: 'Awaiting fix target selection',
      };
    }

    case Step.REFRESH_CI: {
      const ci = useGithubCiStore.getState();
      if (typeof ci.refresh === 'function' && ci.destination) {
        void ci.refresh();
        return { ok: true, summary: 'CI refresh started' };
      }
      return {
        ok: false,
        message: 'CI context unavailable — open the CI panel to refresh',
        retryable: true,
      };
    }

    case Step.VERIFY_CI_FIX: {
      const fix = useCIFixSessionStore.getState();
      const summary = useGithubCiStore.getState().summary;
      if (fix.session && summary && typeof fix.applyVerificationSummary === 'function') {
        fix.applyVerificationSummary(summary);
        return { ok: true, summary: 'CI fix verification applied' };
      }
      return {
        ok: false,
        message: 'CI fix session or summary unavailable — verify from the CI Fix panel',
        retryable: true,
      };
    }

    case Step.BUILD_MULTI_REPO_CONTEXT: {
      const multi = useMultiRepoStore.getState();
      if (!multi.selectedSystemId) {
        void multi.loadSystems();
        return {
          ok: false,
          message: 'Select a multi-repo system in the Multi-Repo panel first',
          retryable: true,
        };
      }
      void multi.buildContext(multi.selectedSystemId);
      return {
        ok: true,
        summary: 'Multi-repo context build started (read-only)',
        artifactKind: 'multi-repo-context',
        showPanel: 'multi-repo',
      };
    }

    case Step.ANALYZE_CHANGE_IMPACT: {
      const multi = useMultiRepoStore.getState();
      if (!multi.selectedSystemId) {
        return {
          ok: false,
          message: 'Select a multi-repo system before analyzing change impact',
          retryable: true,
        };
      }
      const change = githubChangeFromSessions(ctx.sessions);
      if (!change) {
        return {
          ok: false,
          message: 'GitHub change context unavailable for impact analysis',
          retryable: true,
        };
      }
      void multi.analyzeImpact(change);
      return {
        ok: true,
        summary: 'Change impact analysis started (read-only)',
        artifactKind: 'change-impact',
        showPanel: 'multi-repo',
      };
    }

    case Step.TRACE_SYSTEM_FLOW: {
      const multi = useMultiRepoStore.getState();
      if (!multi.selectedSystemId) {
        return {
          ok: false,
          message: 'Select a multi-repo system before tracing flow',
          retryable: true,
        };
      }
      const change = githubChangeFromSessions(ctx.sessions);
      const trigger = change
        ? {
            kind: 'pull_request' as const,
            key: change.pullRequestNumber
              ? `pr:${change.pullRequestNumber}`
              : `${change.owner}/${change.repository}`,
            repository: {
              provider: 'github' as const,
              owner: change.owner,
              repository: change.repository,
            },
            summary: change.summary,
          }
        : { kind: 'unknown' as const, key: 'workflow', summary: 'Trace from workflow goal' };
      void multi.traceFlow(trigger);
      return {
        ok: true,
        summary: 'System flow trace started (read-only)',
        artifactKind: 'system-flow',
        showPanel: 'multi-repo',
      };
    }

    case Step.COMPARE_REQUIREMENT_ACROSS_REPOS: {
      const multi = useMultiRepoStore.getState();
      if (!multi.selectedSystemId) {
        return {
          ok: false,
          message: 'Select a multi-repo system before comparing requirements',
          retryable: true,
        };
      }
      const issueKey = ctx.sessions.jiraIssue?.key;
      if (!issueKey) {
        return {
          ok: false,
          message: 'Jira issue context required to compare requirements across repos',
          retryable: true,
        };
      }
      void multi.compareReq(issueKey);
      return {
        ok: true,
        summary: 'Requirement coverage comparison started (read-only)',
        artifactKind: 'requirement-coverage',
        showPanel: 'multi-repo',
      };
    }

    case Step.FIND_API_CONSUMERS: {
      const multi = useMultiRepoStore.getState();
      if (!multi.selectedSystemId) {
        return {
          ok: false,
          message: 'Select a multi-repo system before finding API consumers',
          retryable: true,
        };
      }
      const op = ctx.sessions.openApiOperation ?? ctx.sessions.pageSelectedOperation;
      if (!op?.path) {
        return {
          ok: false,
          message: 'Select an API operation to find known consumers in selected repositories',
          retryable: true,
        };
      }
      void multi.findApi({
        path: op.path,
        method: op.method,
        operationId: op.operationId,
      });
      return {
        ok: true,
        summary: 'API consumer search started (read-only)',
        artifactKind: 'cross-repo-compatibility',
        showPanel: 'multi-repo',
      };
    }

    case Step.FIND_EVENT_CONSUMERS: {
      const multi = useMultiRepoStore.getState();
      if (!multi.selectedSystemId) {
        return {
          ok: false,
          message: 'Select a multi-repo system before finding event consumers',
          retryable: true,
        };
      }
      const topicFromContext = multi.context?.resources.kafkaTopics[0]?.topic;
      const topicFromFlow =
        multi.lastFlow?.trigger.kind === 'kafka_topic' ? multi.lastFlow.trigger.key : null;
      const topicHint = topicFromContext ?? topicFromFlow;
      if (!topicHint) {
        return {
          ok: false,
          message:
            'No Kafka topic selected — build multi-repo context or trace flow first to identify a topic',
          retryable: true,
        };
      }
      void multi.findEvents({ topic: topicHint });
      return {
        ok: true,
        summary: 'Event consumer search started (read-only)',
        artifactKind: 'cross-repo-compatibility',
        showPanel: 'multi-repo',
      };
    }

    default: {
      const _exhaustive: never = type;
      return { ok: false, message: `Unsupported step type: ${String(_exhaustive)}` };
    }
  }
}

function buildJiraPromptText(sessions: EngineeringSessionsInput): string {
  const issue = sessions.jiraIssue;
  if (!issue) {
    return 'Jira issue context unavailable.';
  }
  return [
    `Issue: ${issue.key}`,
    issue.summary ? `Summary: ${issue.summary}` : null,
    issue.description?.plainText
      ? `Description:\n${issue.description.plainText.slice(0, 6000)}`
      : null,
  ]
    .filter(Boolean)
    .join('\n');
}

function buildGithubPromptText(sessions: EngineeringSessionsInput): string {
  const github =
    sessions.lastReviewContext?.github ??
    (sessions.pageSnapshot?.type === 'github' ? sessions.pageSnapshot.github : undefined) ??
    sessions.pageSnapshot?.github;
  if (!github) {
    return 'GitHub PR context unavailable.';
  }
  const files = (github.changedFiles ?? [])
    .slice(0, 8)
    .map((f) => `- ${f.path}`)
    .join('\n');
  return [
    `PR #${github.pullRequestNumber ?? '?'} ${github.owner ?? ''}/${github.repository ?? ''}`,
    github.pullRequestTitle ? `Title: ${github.pullRequestTitle}` : null,
    files ? `Changed files:\n${files}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

function buildApiPromptText(sessions: EngineeringSessionsInput): string {
  const input = assembleEngineeringBuildInput(sessions);
  return input.api?.contextText ?? 'OpenAPI context unavailable.';
}

function buildCiPromptText(sessions: EngineeringSessionsInput): string {
  const ci = sessions.ciSummary;
  if (!ci) {
    return 'CI summary unavailable.';
  }
  return [
    `CI head ${ci.headSha}`,
    `overall: ${ci.overallStatus}`,
    `passed=${ci.counts.passed} failed=${ci.counts.failed} pending=${ci.counts.pending}`,
  ].join('\n');
}
