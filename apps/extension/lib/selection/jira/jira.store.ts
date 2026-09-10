import { create } from 'zustand';
import type { JiraIssue, JiraConnectionStatus } from '@project-x/types';

import { fetchJiraIssue, getJiraConnection, JiraApiError } from '../../services/jira-api';

type JiraSessionState = {
  connection: JiraConnectionStatus | null;
  issue: JiraIssue | null;
  analyzedUpdatedAt: string | null;
  /** Bound comparison identity — invalidate when PR head changes. */
  comparisonIssueKey: string | null;
  comparisonHeadSha: string | null;
  loading: boolean;
  error: string | null;
  abortController: AbortController | null;
  loadConnection: () => Promise<void>;
  loadIssue: (issueKey: string, host?: string) => Promise<JiraIssue | null>;
  markAnalyzed: (updatedAt?: string) => void;
  markComparison: (issueKey: string, headSha: string) => void;
  isIssueStale: () => boolean;
  isComparisonStale: (currentHeadSha?: string | null) => boolean;
  clearIssue: () => void;
  clear: () => void;
};

export const useJiraSessionStore = create<JiraSessionState>((set, get) => ({
  connection: null,
  issue: null,
  analyzedUpdatedAt: null,
  comparisonIssueKey: null,
  comparisonHeadSha: null,
  loading: false,
  error: null,
  abortController: null,

  loadConnection: async () => {
    try {
      const connection = await getJiraConnection();
      set({ connection, error: null });
    } catch (err) {
      set({
        connection: { connected: false },
        error: err instanceof JiraApiError ? err.message : 'Unable to load Jira connection.',
      });
    }
  },

  loadIssue: async (issueKey, host) => {
    get().abortController?.abort();
    const controller = new AbortController();
    set({ loading: true, error: null, abortController: controller });
    try {
      const issue = await fetchJiraIssue(issueKey, host, controller.signal);
      set({
        issue,
        loading: false,
        abortController: null,
        analyzedUpdatedAt: null,
      });
      return issue;
    } catch (err) {
      if (controller.signal.aborted) {
        return null;
      }
      set({
        loading: false,
        error: err instanceof JiraApiError ? err.message : 'Unable to load Jira issue.',
        abortController: null,
        issue: null,
      });
      return null;
    }
  },

  markAnalyzed: (updatedAt) => {
    set({ analyzedUpdatedAt: updatedAt ?? get().issue?.updatedAt ?? null });
  },

  isIssueStale: () => {
    const { issue, analyzedUpdatedAt } = get();
    if (!issue || !analyzedUpdatedAt || !issue.updatedAt) {
      return false;
    }
    return issue.updatedAt !== analyzedUpdatedAt;
  },

  markComparison: (issueKey, headSha) => {
    set({
      comparisonIssueKey: issueKey.toUpperCase(),
      comparisonHeadSha: headSha.toLowerCase(),
    });
  },

  isComparisonStale: (currentHeadSha) => {
    const { comparisonHeadSha, comparisonIssueKey, issue } = get();
    if (!comparisonHeadSha || !comparisonIssueKey) {
      return false;
    }
    if (issue && issue.key !== comparisonIssueKey) {
      return true;
    }
    if (!currentHeadSha) {
      return false;
    }
    return currentHeadSha.toLowerCase() !== comparisonHeadSha;
  },

  clearIssue: () => {
    get().abortController?.abort();
    set({
      issue: null,
      analyzedUpdatedAt: null,
      comparisonIssueKey: null,
      comparisonHeadSha: null,
      error: null,
      abortController: null,
    });
  },

  clear: () => {
    get().abortController?.abort();
    set({
      issue: null,
      analyzedUpdatedAt: null,
      comparisonIssueKey: null,
      comparisonHeadSha: null,
      error: null,
      loading: false,
      abortController: null,
    });
  },
}));

export function buildJiraIssuePromptText(issue: JiraIssue): string {
  const parts = [
    `Issue: ${issue.key}`,
    `Summary: ${issue.summary}`,
    issue.issueType ? `Type: ${issue.issueType}` : null,
    issue.status?.name ? `Status: ${issue.status.name}` : null,
    issue.priority ? `Priority: ${issue.priority}` : null,
    issue.project.name
      ? `Project: ${issue.project.name} (${issue.project.key})`
      : `Project: ${issue.project.key}`,
    issue.description?.plainText
      ? `Description:\n${issue.description.plainText}`
      : 'Description: (empty)',
    issue.attachmentCount && issue.attachmentCount > 0
      ? `Attachments: ${issue.attachmentCount} file(s) not analyzed${
          issue.attachmentNames?.length ? ` (${issue.attachmentNames.join(', ')})` : ''
        }`
      : null,
    issue.comments && issue.comments.length > 0
      ? `Recent comments:\n${issue.comments
          .map(
            (c) =>
              `- ${c.authorDisplayName ?? 'Someone'} (${c.createdAt ?? '?'}):\n${c.body.plainText}`,
          )
          .join('\n')}`
      : null,
    issue.truncated ? 'Note: issue context was truncated.' : null,
  ];
  return parts.filter(Boolean).join('\n\n').slice(0, 18_000);
}
