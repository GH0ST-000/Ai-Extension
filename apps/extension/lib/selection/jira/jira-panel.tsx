import { useCallback, useEffect } from 'react';
import { AIAction } from '@project-x/types';

import { cn } from '~/lib/utils/cn';

import { ACTION_ICONS } from '../components/action-icons';
import { useSelectionToolbarStore } from '../store';
import { buildJiraIssuePromptText, useJiraSessionStore } from './jira.store';

const JIRA_ACTIONS: Array<{ id: AIAction; label: string; description: string }> = [
  {
    id: AIAction.SUMMARIZE_JIRA_ISSUE,
    label: 'Summarize Issue',
    description: 'Engineering-oriented summary',
  },
  {
    id: AIAction.EXTRACT_ACCEPTANCE_CRITERIA,
    label: 'Acceptance Criteria',
    description: 'Explicit vs inferred',
  },
  {
    id: AIAction.CREATE_TECHNICAL_PLAN,
    label: 'Technical Plan',
    description: 'Implementation outline',
  },
  {
    id: AIAction.ANALYZE_JIRA_RISKS,
    label: 'Risks & Questions',
    description: 'Requirement risks',
  },
];

export function JiraIssuePanel(props: {
  issueKey: string;
  siteHost?: string;
  onCompareWithPr?: () => void;
  relatedPrLabel?: string | null;
  comparisonStale?: boolean;
  /** When true, omit outer card — used inside the tabbed ActionMenu. */
  embedded?: boolean;
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

  const body = (
    <div className={props.embedded ? 'px-1 pb-1 pt-2' : undefined}>
      {!props.embedded ? (
        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
          Project X · Jira
        </p>
      ) : null}

      <div className={props.embedded ? 'px-2' : undefined}>
        <p className="text-[12px] font-semibold text-primary">
          {issue?.key ?? props.issueKey}
          {issue?.summary ? (
            <span className="font-medium text-secondary"> — {issue.summary}</span>
          ) : null}
        </p>
        {issue ? (
          <p className="mt-0.5 text-[11px] text-secondary">
            {[issue.status?.name, issue.priority].filter(Boolean).join(' · ') || 'Issue loaded'}
          </p>
        ) : null}
      </div>

      {loading ? (
        <p className="mt-2 px-2 text-[11px] text-accent" role="status">
          Loading issue…
        </p>
      ) : null}
      {error ? (
        <p className="mt-2 px-2 text-[11px] text-[#e11d48]" role="alert">
          {error}
        </p>
      ) : null}
      {isIssueStale() ? (
        <p className="mt-2 px-2 text-[11px] text-secondary" role="status">
          This Jira issue changed since this analysis was generated.
        </p>
      ) : null}
      {props.comparisonStale ? (
        <p className="mt-2 px-2 text-[11px] text-secondary" role="status">
          The pull request changed since this comparison was generated.
        </p>
      ) : null}
      {issue?.attachmentCount && issue.attachmentCount > 0 ? (
        <p className="mt-1 px-2 text-[10px] text-muted">
          Attachments referenced — not analyzed by Project X.
        </p>
      ) : null}

      {connection && !connection.connected ? (
        <p className="mt-2 px-2 text-[11px] text-secondary">
          Connect Jira in dashboard Settings to use issue intelligence.
        </p>
      ) : (
        <div className="mt-1 flex flex-col">
          {JIRA_ACTIONS.map((action) => {
            const Icon = ACTION_ICONS[action.id];
            return (
              <button
                key={action.id}
                type="button"
                disabled={!issue || loading}
                onClick={() => runAction(action.id)}
                className={cn(
                  'group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left',
                  'text-primary transition-colors duration-100',
                  'hover:bg-hover focus-visible:bg-active',
                  'outline-none focus-visible:ring-1 focus-visible:ring-accent/40',
                  'disabled:pointer-events-none disabled:opacity-35',
                )}
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-icon text-secondary transition-colors group-hover:text-accent">
                  <Icon className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[12.5px] font-medium leading-4 tracking-tight">
                    {action.label}
                  </span>
                  <span className="mt-px block truncate text-[11px] leading-tight text-muted">
                    {action.description}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}

      {props.relatedPrLabel || props.onCompareWithPr ? (
        <div className="mt-0.5 border-t border-border px-1 pt-1">
          {props.relatedPrLabel ? (
            <p className="px-2 pt-1 text-[10px] text-muted">{props.relatedPrLabel}</p>
          ) : null}
          {props.onCompareWithPr ? (
            <button
              type="button"
              disabled={!issue}
              onClick={props.onCompareWithPr}
              className={cn(
                'flex w-full items-center rounded-md px-2 py-1.5 text-left',
                'text-[12px] font-medium text-accent transition-colors',
                'hover:bg-hover disabled:opacity-40',
              )}
            >
              Compare with PR
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  if (props.embedded) {
    return body;
  }

  return (
    <div className="mt-2 max-h-[360px] overflow-y-auto rounded-lg border border-border bg-surface px-2.5 py-2">
      {body}
    </div>
  );
}
