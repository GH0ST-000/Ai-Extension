import { useCallback, useEffect } from 'react';
import { AIAction } from '@project-x/types';

import { useSelectionToolbarStore } from '../store';
import { buildJiraIssuePromptText, useJiraSessionStore } from './jira.store';

const JIRA_ACTIONS: Array<{ id: AIAction; label: string }> = [
  { id: AIAction.SUMMARIZE_JIRA_ISSUE, label: 'Summarize Issue' },
  { id: AIAction.EXTRACT_ACCEPTANCE_CRITERIA, label: 'Acceptance Criteria' },
  { id: AIAction.CREATE_TECHNICAL_PLAN, label: 'Technical Plan' },
  { id: AIAction.ANALYZE_JIRA_RISKS, label: 'Risks & Questions' },
];

export function JiraIssuePanel(props: {
  issueKey: string;
  siteHost?: string;
  onCompareWithPr?: () => void;
  relatedPrLabel?: string | null;
  comparisonStale?: boolean;
}) {
  const connection = useJiraSessionStore((s) => s.connection);
  const issue = useJiraSessionStore((s) => s.issue);
  const loading = useJiraSessionStore((s) => s.loading);
  const error = useJiraSessionStore((s) => s.error);
  const loadConnection = useJiraSessionStore((s) => s.loadConnection);
  const loadIssue = useJiraSessionStore((s) => s.loadIssue);
  const markAnalyzed = useJiraSessionStore((s) => s.markAnalyzed);
  const isIssueStale = useJiraSessionStore((s) => s.isIssueStale);
  const startAction = useSelectionToolbarStore((s) => s.startAction);

  useEffect(() => {
    void loadConnection();
  }, [loadConnection]);

  useEffect(() => {
    if (connection?.connected) {
      void loadIssue(props.issueKey, props.siteHost);
    }
  }, [connection?.connected, loadIssue, props.issueKey, props.siteHost]);

  const runAction = useCallback(
    (action: AIAction) => {
      const current = useJiraSessionStore.getState().issue;
      if (!current) {
        return;
      }
      const text = buildJiraIssuePromptText(current);
      useSelectionToolbarStore.setState({ selectedText: text });
      markAnalyzed(current.updatedAt);
      void startAction(action);
    },
    [markAnalyzed, startAction],
  );

  if (connection && !connection.connected) {
    return (
      <div className="mt-2 rounded-lg border border-border bg-surface px-2.5 py-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
          Project X · Jira
        </p>
        <p className="mt-1 text-[11px] text-secondary">
          Connect Jira in dashboard Settings to use issue intelligence.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-2 max-h-[360px] overflow-y-auto rounded-lg border border-border bg-surface px-2.5 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
        Project X · Jira
      </p>
      <p className="mt-0.5 text-[12px] font-semibold text-primary">
        {issue?.key ?? props.issueKey}
        {issue?.summary ? ` — ${issue.summary}` : ''}
      </p>
      {issue ? (
        <p className="text-[11px] text-secondary">
          {[issue.status?.name, issue.priority].filter(Boolean).join(' · ') || 'Issue loaded'}
        </p>
      ) : null}

      {loading ? (
        <p className="mt-2 text-[11px] text-accent" role="status">
          Loading issue…
        </p>
      ) : null}
      {error ? (
        <p className="mt-2 text-[11px] text-[#e11d48]" role="alert">
          {error}
        </p>
      ) : null}
      {isIssueStale() ? (
        <p className="mt-2 text-[11px] text-secondary" role="status">
          This Jira issue changed since this analysis was generated.
        </p>
      ) : null}
      {props.comparisonStale ? (
        <p className="mt-2 text-[11px] text-secondary" role="status">
          The pull request changed since this comparison was generated.
        </p>
      ) : null}
      {issue?.attachmentCount && issue.attachmentCount > 0 ? (
        <p className="mt-1 text-[10px] text-muted">
          This issue references attachments that Project X did not analyze.
        </p>
      ) : null}

      <div className="mt-2 flex flex-wrap gap-1 border-t border-border pt-2">
        {JIRA_ACTIONS.map((action) => (
          <button
            key={action.id}
            type="button"
            disabled={!issue || loading}
            onClick={() => runAction(action.id)}
            className="rounded-md bg-accent-soft px-2 py-1 text-[11px] font-semibold text-accent disabled:opacity-40"
          >
            {action.label}
          </button>
        ))}
      </div>

      {props.relatedPrLabel || props.onCompareWithPr ? (
        <div className="mt-2 border-t border-border pt-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
            Related Development
          </p>
          {props.relatedPrLabel ? (
            <p className="mt-1 text-[11px] text-secondary">{props.relatedPrLabel}</p>
          ) : null}
          {props.onCompareWithPr ? (
            <button
              type="button"
              disabled={!issue}
              onClick={props.onCompareWithPr}
              className="mt-1 rounded-md px-2 py-1 text-[11px] font-semibold text-accent hover:bg-hover disabled:opacity-40"
            >
              Compare with PR
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
