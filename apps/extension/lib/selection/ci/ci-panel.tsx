import type { CICheckConclusion, CICheckRunStatus, CIOverallStatus } from '@project-x/types';

import { formatCiEntryLabel, useGithubCiStore } from './ci.store';
import { safeHttpsHref } from './safe-external-url';
import { CiCheckDetailPanel } from './ci-check-detail';

function overallLabel(status: CIOverallStatus): string {
  switch (status) {
    case 'SUCCESS':
      return 'Passed';
    case 'FAILURE':
      return 'Failed';
    case 'PENDING':
      return 'Running';
    case 'CANCELLED':
      return 'Cancelled';
    case 'NEUTRAL':
      return 'Neutral';
    case 'SKIPPED':
      return 'Skipped';
    default:
      return 'Unknown';
  }
}

function checkStatusLabel(status: CICheckRunStatus, conclusion: CICheckConclusion): string {
  if (status === 'IN_PROGRESS' || status === 'QUEUED' || status === 'WAITING') {
    return 'Running';
  }
  switch (conclusion) {
    case 'SUCCESS':
      return 'Passed';
    case 'FAILURE':
    case 'TIMED_OUT':
    case 'ACTION_REQUIRED':
      return 'Failed';
    case 'CANCELLED':
      return 'Cancelled';
    case 'SKIPPED':
      return 'Skipped';
    case 'NEUTRAL':
      return 'Neutral';
    default:
      return status === 'COMPLETED' ? 'Completed' : 'Unknown';
  }
}

function statusGlyph(status: CICheckRunStatus, conclusion: CICheckConclusion): string {
  if (status === 'IN_PROGRESS' || status === 'QUEUED' || status === 'WAITING') {
    return '◌';
  }
  if (conclusion === 'FAILURE' || conclusion === 'TIMED_OUT' || conclusion === 'ACTION_REQUIRED') {
    return '✕';
  }
  if (conclusion === 'SUCCESS') {
    return '✓';
  }
  if (conclusion === 'CANCELLED') {
    return '⊘';
  }
  return '·';
}

function durationLabel(startedAt?: string, completedAt?: string): string | null {
  if (!startedAt || !completedAt) {
    return null;
  }
  const ms = Date.parse(completedAt) - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) {
    return null;
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return `${minutes}m ${rem}s`;
}

export function CiPanel() {
  const view = useGithubCiStore((s) => s.view);
  const destination = useGithubCiStore((s) => s.destination);
  const summary = useGithubCiStore((s) => s.summary);
  const staleAfterCommit = useGithubCiStore((s) => s.staleAfterCommit);
  const loadingSummary = useGithubCiStore((s) => s.loadingSummary);
  const error = useGithubCiStore((s) => s.error);
  const refresh = useGithubCiStore((s) => s.refresh);
  const close = useGithubCiStore((s) => s.close);
  const selectCheck = useGithubCiStore((s) => s.selectCheck);

  if (view === 'closed' || !destination) {
    return null;
  }

  if (view === 'check-detail') {
    return <CiCheckDetailPanel />;
  }

  return (
    <div className="mt-2 max-h-[360px] overflow-y-auto rounded-lg border border-border bg-surface px-2.5 py-2">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
            CI Status
          </p>
          <p className="mt-0.5 text-[11px] text-secondary">
            {destination.owner}/{destination.repository} · PR #{destination.pullRequestNumber}
          </p>
        </div>
        <button
          type="button"
          onClick={close}
          className="rounded-md px-1.5 py-0.5 text-[11px] text-secondary hover:bg-hover hover:text-primary"
          aria-label="Close CI panel"
        >
          Close
        </button>
      </div>

      {staleAfterCommit ? (
        <p
          className="mt-2 rounded-md bg-hover px-2 py-1.5 text-[11px] text-secondary"
          role="status"
        >
          PR updated. Refresh CI status to see checks for the new commit.
        </p>
      ) : null}

      {loadingSummary && !summary ? (
        <p className="mt-2 text-[11px] text-accent" role="status">
          Loading CI status…
        </p>
      ) : null}

      {error ? (
        <p className="mt-2 text-[11px] text-[#e11d48]" role="alert">
          {error}
        </p>
      ) : null}

      {summary ? (
        <>
          <p className="mt-2 font-mono text-[11px] text-primary">
            Head: {summary.headSha.slice(0, 7)}
          </p>
          <p
            className="mt-1 text-[11px] text-secondary"
            aria-label={`Overall CI ${overallLabel(summary.overallStatus)}`}
          >
            <span className="font-semibold text-primary">
              {overallLabel(summary.overallStatus)}
            </span>
            {' · '}
            {summary.counts.failed > 0 ? `${summary.counts.failed} failed` : null}
            {summary.counts.failed > 0 && summary.counts.passed > 0 ? ' · ' : null}
            {summary.counts.passed > 0 ? `${summary.counts.passed} passed` : null}
            {(summary.counts.failed > 0 || summary.counts.passed > 0) && summary.counts.pending > 0
              ? ' · '
              : null}
            {summary.counts.pending > 0 ? `${summary.counts.pending} running` : null}
            {summary.counts.failed === 0 &&
            summary.counts.passed === 0 &&
            summary.counts.pending === 0
              ? formatCiEntryLabel(summary)
              : null}
          </p>
          {summary.partialData ? (
            <p className="mt-1 text-[10px] text-muted">Some check sources were unavailable.</p>
          ) : null}

          <ul className="mt-2 space-y-1 border-t border-border pt-2" aria-label="CI checks">
            {summary.checks.map((check) => {
              const label = checkStatusLabel(check.status, check.conclusion);
              const duration = durationLabel(check.startedAt, check.completedAt);
              const failed =
                check.conclusion === 'FAILURE' ||
                check.conclusion === 'TIMED_OUT' ||
                check.conclusion === 'ACTION_REQUIRED';
              return (
                <li key={check.id}>
                  <button
                    type="button"
                    disabled={!failed && !check.canInspectDetails}
                    onClick={() => {
                      void selectCheck(check.id);
                    }}
                    className="flex w-full items-start gap-1.5 rounded-md px-1 py-1 text-left text-[11px] hover:bg-hover disabled:cursor-default disabled:opacity-70"
                    aria-label={`${check.name}, ${label}`}
                  >
                    <span aria-hidden="true" className="mt-0.5 w-3 shrink-0 text-center">
                      {statusGlyph(check.status, check.conclusion)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-primary">{check.name}</span>
                      <span className="block text-[10px] text-secondary">
                        {label}
                        {duration ? ` · ${duration}` : ''}
                        {check.source ? ` · ${check.source}` : ''}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}

      <div className="mt-2 flex flex-wrap gap-1 border-t border-border pt-2">
        <button
          type="button"
          onClick={() => {
            void refresh();
          }}
          disabled={loadingSummary}
          className="rounded-md bg-accent-soft px-2 py-1 text-[11px] font-semibold text-accent disabled:opacity-40"
        >
          {loadingSummary ? 'Refreshing…' : 'Refresh'}
        </button>
        <button
          type="button"
          onClick={close}
          className="rounded-md px-2 py-1 text-[11px] font-medium text-secondary hover:bg-hover hover:text-primary"
        >
          Back
        </button>
      </div>
    </div>
  );
}

export function CiEntryButton(props: { onOpen: () => void; summaryLabel?: string }) {
  return (
    <button
      type="button"
      onClick={props.onOpen}
      className="rounded-md bg-hover px-2 py-1 text-[11px] font-semibold text-primary hover:bg-border"
      aria-label="Open CI status"
    >
      {props.summaryLabel ?? 'CI'}
    </button>
  );
}

export { safeHttpsHref };
