'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { partialScopeUnavailable } from '@project-x/shared';

import type { AnalysisSummary, ErrorGuidance } from './systems-model';
import { repoLabel } from './systems-model';
import { BUTTON_GHOST, BUTTON_SECONDARY, Callout, Spinner } from './systems-ui';

export type AnalysisState =
  | { status: 'idle' }
  | { status: 'running'; kind: 'refresh' | 'discover' }
  | {
      status: 'done';
      kind: 'refresh' | 'discover';
      summary: AnalysisSummary;
      raw: unknown;
      finishedAt: string;
    }
  | { status: 'error'; kind: 'refresh' | 'discover'; error: ErrorGuidance };

const RUNNING_TEXT = {
  refresh: 'Analyzing repositories. This can take up to a minute for larger systems.',
  discover: 'Looking for dependencies between repositories…',
} as const;

/**
 * Result of the last Refresh / Discover in this session. No fake progress: the API reports
 * nothing until it finishes, so the running state is indeterminate.
 */
function AnalysisResultBody({
  state,
  onRetry,
  onAddRepository,
  onDismiss,
}: {
  state: AnalysisState;
  onRetry: () => void;
  onAddRepository: () => void;
  onDismiss: () => void;
}) {
  if (state.status === 'idle') return null;

  if (state.status === 'running') {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex items-center gap-3 rounded-2xl border border-line bg-mist/60 px-4 py-3 text-sm text-ink"
      >
        <Spinner />
        {RUNNING_TEXT[state.kind]}
      </div>
    );
  }

  if (state.status === 'error') {
    const { error } = state;
    return (
      <Callout
        tone="error"
        role="alert"
        title={error.title}
        action={
          <>
            {error.retryable ? (
              <button type="button" onClick={onRetry} className={BUTTON_SECONDARY}>
                Try again
              </button>
            ) : null}
            {error.action ? (
              <Link href={error.action.href} className={BUTTON_SECONDARY}>
                {error.action.label}
              </Link>
            ) : null}
            <button type="button" onClick={onDismiss} className={BUTTON_GHOST}>
              Dismiss
            </button>
          </>
        }
      >
        {error.message}
      </Callout>
    );
  }

  const { summary } = state;
  return (
    <div className="space-y-2" aria-live="polite">
      <Callout
        tone={summary.tone}
        role="status"
        title={
          <>
            {summary.title}
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              <time dateTime={state.finishedAt}>
                {new Date(state.finishedAt).toLocaleTimeString()}
              </time>
            </span>
          </>
        }
        action={
          <>
            {summary.suggestAddRepository ? (
              <button type="button" onClick={onAddRepository} className={BUTTON_SECONDARY}>
                Add repository
              </button>
            ) : null}
            <button type="button" onClick={onDismiss} className={BUTTON_GHOST}>
              Dismiss
            </button>
          </>
        }
      >
        <p>{summary.lines.join(' ')}</p>
        {summary.suggestAddRepository ? (
          <p className="mt-1">
            This system currently contains one repository. Add another related repository to explore
            cross-repository dependencies.
          </p>
        ) : null}
        {summary.unavailable.length > 0 ? (
          <div className="mt-2">
            <p className="font-semibold text-ink">
              {summary.unavailable.length === 1
                ? '1 repository could not be analyzed'
                : `${summary.unavailable.length} repositories could not be analyzed`}
            </p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {summary.unavailable.map((repo) => (
                <li key={repoLabel(repo)}>{partialScopeUnavailable(repoLabel(repo))}</li>
              ))}
            </ul>
            <p className="mt-1">
              Check that your GitHub connection can still access them, then refresh again.
            </p>
          </div>
        ) : null}
        {summary.notes.length > 0 ? (
          <ul className="mt-2 list-disc space-y-0.5 pl-5">
            {summary.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        ) : null}
        {summary.truncated ? (
          <p className="mt-2">
            <span className="font-semibold text-ink">Partial results.</span> The analysis reached
            its size limit, so some files or repositories were not examined. What is shown is
            accurate but may be incomplete.
          </p>
        ) : null}
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer select-none font-semibold text-ink/80 hover:text-ink">
            Technical details
          </summary>
          <pre className="mt-2 max-h-60 overflow-auto rounded-xl border border-line bg-panel p-3 font-mono text-[11px] text-ink">
            {JSON.stringify(state.raw, null, 2)}
          </pre>
        </details>
      </Callout>
    </div>
  );
}

/**
 * Wrapper that brings a finished result into view (on phones the result renders below the
 * fold, so otherwise nothing visibly happens). `nearest` does not move a visible result.
 */
export function AnalysisResult(props: Parameters<typeof AnalysisResultBody>[0]) {
  const ref = useRef<HTMLDivElement>(null);
  const settled = props.state.status === 'done' || props.state.status === 'error';
  const key = settled && 'kind' in props.state ? `${props.state.status}:${props.state.kind}` : null;
  useEffect(() => {
    if (key) ref.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [key, props.state]);
  if (props.state.status === 'idle') return null;
  return (
    <div ref={ref} className="scroll-mt-24">
      <AnalysisResultBody {...props} />
    </div>
  );
}
