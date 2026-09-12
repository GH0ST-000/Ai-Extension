'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ContextDriftSummary,
  WorkflowExecution,
  WorkflowExecutionDetail,
} from '@project-x/types';

import {
  ApiError,
  getWorkflowExecution,
  listWorkflowExecutions,
  previewWorkflowReplay,
  resumeWorkflowExecution,
  retryWorkflowExecution,
  replayWorkflowExecution,
} from '../../../lib/api';

const BAND_STYLES: Record<string, string> = {
  Excellent: 'border-accent bg-accent-soft text-ink',
  Good: 'border-line bg-mist text-ink',
  Warning: 'border-line bg-panel text-muted-foreground',
  Poor: 'border-line bg-panel text-muted-foreground',
  Critical: 'border-line bg-panel text-muted-foreground',
};

function apiMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

function formatDuration(ms?: number): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export default function ReliabilityPage() {
  const [executions, setExecutions] = useState<WorkflowExecution[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<WorkflowExecutionDetail | null>(null);
  const [drift, setDrift] = useState<ContextDriftSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const selected = useMemo(
    () => executions.find((row) => row.id === selectedId) ?? null,
    [executions, selectedId],
  );

  const loadList = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await listWorkflowExecutions();
      setExecutions(list);
      setSelectedId((prev) => {
        if (prev && list.some((row) => row.id === prev)) return prev;
        return list[0]?.id ?? null;
      });
    } catch (err) {
      setError(apiMessage(err, 'Unable to load workflow executions.'));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (executionId: string) => {
    setBusy(true);
    setError(null);
    try {
      const next = await getWorkflowExecution(executionId);
      setDetail(next);
      setDrift(null);
    } catch (err) {
      setError(apiMessage(err, 'Unable to load execution detail.'));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  async function onResume() {
    if (!selectedId) return;
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const result = await resumeWorkflowExecution(selectedId);
      setMessage(
        `Resumed from ${result.skipCompletedThrough}. New execution ${result.execution.id}.`,
      );
      await loadList();
      setSelectedId(result.execution.id);
    } catch (err) {
      setError(apiMessage(err, 'Resume failed.'));
    } finally {
      setBusy(false);
    }
  }

  async function onReplayPreview() {
    if (!selectedId || !detail) return;
    setBusy(true);
    setError(null);
    try {
      const preview = await previewWorkflowReplay(selectedId, {
        currentContext: detail.contextVersion,
      });
      setDrift(preview.drift);
      setMessage(
        preview.drift.hasDrift
          ? 'Replay available with context drift — writes still require confirmation.'
          : 'Replay available — GitHub writes still require confirmation.',
      );
    } catch (err) {
      setError(apiMessage(err, 'Replay preview failed.'));
    } finally {
      setBusy(false);
    }
  }

  async function onReplay() {
    if (!selectedId || !detail) return;
    setBusy(true);
    setError(null);
    try {
      const next = await replayWorkflowExecution(selectedId, {
        currentContext: detail.contextVersion,
      });
      setMessage(`Replay started as ${next.id}. Write actions still need confirmation.`);
      await loadList();
      setSelectedId(next.id);
    } catch (err) {
      setError(apiMessage(err, 'Replay failed.'));
    } finally {
      setBusy(false);
    }
  }

  async function onRetryAi() {
    if (!selectedId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await retryWorkflowExecution(selectedId, {
        stage: 'AI_FETCH',
        category: 'TIMEOUT',
        attempt: selected?.retryCount ?? 0,
      });
      if (!result.decision.allowed) {
        setMessage(result.decision.reason);
        return;
      }
      setMessage(`Retry created ${result.execution?.id ?? ''}`);
      await loadList();
      if (result.execution) setSelectedId(result.execution.id);
    } catch (err) {
      setError(apiMessage(err, 'Retry failed.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Reliability</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Workflow executions, health, audit timeline, checkpoints, resume, and replay — without
          external observability vendors.
        </p>
      </header>

      {error ? (
        <p className="rounded-xl border border-line bg-panel px-3 py-2 text-sm text-ink">{error}</p>
      ) : null}
      {message ? (
        <p className="rounded-xl border border-accent bg-accent-soft px-3 py-2 text-sm text-ink">
          {message}
        </p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-ink">Recent executions</h2>
            <button
              type="button"
              onClick={() => void loadList()}
              disabled={loading}
              className="rounded-lg border border-line px-2.5 py-1 text-xs font-semibold text-ink"
            >
              Refresh
            </button>
          </div>

          {loading && executions.length === 0 ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : null}

          {executions.length === 0 && !loading ? (
            <p className="text-sm text-muted-foreground">
              No executions yet. Run a developer workflow from the extension to create an audit
              trail.
            </p>
          ) : null}

          <ul className="space-y-2">
            {executions.map((row) => {
              const active = row.id === selectedId;
              return (
                <li key={row.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(row.id)}
                    className={[
                      'w-full rounded-xl border px-3 py-2.5 text-left transition',
                      active
                        ? 'border-accent bg-accent-soft'
                        : 'border-line bg-panel/70 hover:bg-panel',
                    ].join(' ')}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-semibold text-ink">
                        {row.goal ?? row.workflowId}
                      </span>
                      <span
                        className={[
                          'shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold',
                          BAND_STYLES[row.healthBand] ?? BAND_STYLES.Warning,
                        ].join(' ')}
                      >
                        {row.healthBand}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                      <span>{row.status}</span>
                      <span>#{row.executionNumber}</span>
                      <span>{row.trigger}</span>
                      <span>{formatDuration(row.durationMs)}</span>
                      <span>{row.artifactCount} artifacts</span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="space-y-4">
          {!selected || !detail ? (
            <p className="text-sm text-muted-foreground">
              Select an execution to inspect reliability detail.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy || !detail.resumeAvailable}
                  onClick={() => void onResume()}
                  className="rounded-lg bg-ink px-3 py-1.5 text-xs font-semibold text-inverse disabled:opacity-40"
                >
                  Resume
                </button>
                <button
                  type="button"
                  disabled={busy || !detail.replayAvailable}
                  onClick={() => void onReplayPreview()}
                  className="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-ink disabled:opacity-40"
                >
                  Preview replay
                </button>
                <button
                  type="button"
                  disabled={busy || !detail.replayAvailable}
                  onClick={() => void onReplay()}
                  className="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-ink disabled:opacity-40"
                >
                  Replay
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void onRetryAi()}
                  className="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-ink disabled:opacity-40"
                >
                  Retry AI
                </button>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <MetaCard label="Health" value={`${detail.healthScore} · ${detail.healthBand}`} />
                <MetaCard label="Duration" value={formatDuration(detail.durationMs)} />
                <MetaCard label="Failures" value={String(detail.failureCount)} />
                <MetaCard label="Retries" value={String(detail.retryCount)} />
                <MetaCard
                  label="Prompt"
                  value={
                    detail.promptVersion
                      ? `${detail.promptVersion.name}@v${detail.promptVersion.version}`
                      : '—'
                  }
                />
                <MetaCard
                  label="Context"
                  value={detail.contextVersion.repository ?? detail.contextVersion.prSha ?? '—'}
                />
              </div>

              {drift ? (
                <div className="rounded-xl border border-line bg-panel/80 p-3">
                  <h3 className="text-sm font-semibold text-ink">Context drift</h3>
                  <p className="mt-1 text-xs text-muted-foreground">{drift.summary}</p>
                  <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                    {drift.fields.map((field) => (
                      <li key={field.key}>
                        {field.label}: {field.previous ?? '∅'} → {field.current ?? '∅'}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div className="rounded-xl border border-line bg-panel/80 p-3">
                <h3 className="text-sm font-semibold text-ink">Timeline</h3>
                <ol className="mt-2 space-y-1.5">
                  {detail.timeline.map((event, index) => (
                    <li
                      key={`${event.timestamp}-${index}`}
                      className="text-xs text-muted-foreground"
                    >
                      <span className="font-medium text-ink">{event.label}</span>
                      <span className="mx-1.5">·</span>
                      <span>{new Date(event.timestamp).toLocaleString()}</span>
                      {event.message ? <span className="ml-1.5">— {event.message}</span> : null}
                    </li>
                  ))}
                  {detail.timeline.length === 0 ? (
                    <li className="text-xs text-muted-foreground">No timeline events.</li>
                  ) : null}
                </ol>
              </div>

              <div className="rounded-xl border border-line bg-panel/80 p-3">
                <h3 className="text-sm font-semibold text-ink">Artifact lineage</h3>
                <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                  {detail.lineage.nodes.map((node) => (
                    <li key={node.id}>
                      <span className="font-medium text-ink">{node.kind}</span>
                      <span className="mx-1">·</span>
                      <span>{node.id}</span>
                      {node.summary ? <span className="ml-1">— {node.summary}</span> : null}
                    </li>
                  ))}
                  {detail.lineage.edges.map((edge) => (
                    <li key={`${edge.fromArtifactId}->${edge.toArtifactId}`}>
                      {edge.fromArtifactId} → {edge.toArtifactId} ({edge.relation})
                    </li>
                  ))}
                  {detail.lineage.nodes.length === 0 ? (
                    <li>No artifact lineage recorded.</li>
                  ) : null}
                </ul>
              </div>

              {detail.failures.length > 0 ? (
                <div className="rounded-xl border border-line bg-panel/80 p-3">
                  <h3 className="text-sm font-semibold text-ink">Failures</h3>
                  <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                    {detail.failures.map((failure, index) => (
                      <li key={`${failure.category}-${index}`}>
                        <span className="font-medium text-ink">{failure.category}</span>
                        {failure.retryable ? ' · retryable' : ' · not retryable'} —{' '}
                        {failure.userMessage}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function MetaCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-line bg-panel/70 px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="truncate text-sm font-semibold text-ink">{value}</div>
    </div>
  );
}
