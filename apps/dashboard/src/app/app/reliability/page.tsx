'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { WorkflowExecution, WorkflowExecutionDetail } from '@project-x/types';

import { ApiError, getWorkflowExecution, listWorkflowExecutions } from '../../../lib/api';

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
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  // Read-only: recovery (resume / replay) happens in the extension's Workflow panel, which
  // actually re-runs steps. Server-side resume/replay/retry from here only created execution
  // records that nothing executed, so those controls are intentionally not offered.

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Reliability</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Read-only history of multi-step runs started from the Workflow tab in the extension:
          status, audit timeline, and checkpoints. Resume and replay a run from the extension.
        </p>
      </header>

      {error ? (
        <p className="rounded-xl border border-line bg-panel px-3 py-2 text-sm text-ink">{error}</p>
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
            <div className="rounded-2xl border border-dashed border-line px-4 py-6">
              <p className="text-sm font-semibold text-ink">No workflow runs yet</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Runs started from the Workflow tab in the extension appear here. PR reviews are
                saved in{' '}
                <Link href="/app/reviews" className="font-semibold text-ink underline">
                  Review history
                </Link>
                .
              </p>
            </div>
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
              {busy ? 'Loading execution…' : 'Select an execution to inspect reliability detail.'}
            </p>
          ) : (
            <>
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

              <div className="rounded-xl border border-line bg-panel/80 p-3">
                <h3 className="text-sm font-semibold text-ink">Context versions</h3>
                <dl className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
                  {(
                    [
                      ['repository', detail.contextVersion.repository],
                      ['pr', detail.contextVersion.prNumber?.toString()],
                      ['prSha', detail.contextVersion.prSha],
                      ['jira', detail.contextVersion.jiraIssueKey],
                      ['jiraUpdated', detail.contextVersion.jiraUpdatedAt],
                      ['openapi', detail.contextVersion.openapiHash],
                      ['memory', detail.contextVersion.memoryVersion],
                      ['system', detail.contextVersion.systemContextVersion],
                      ['planner', detail.contextVersion.plannerVersion],
                      ['prompt', detail.contextVersion.promptVersion],
                      ['model', detail.contextVersion.aiModel],
                      ['provider', detail.contextVersion.aiProvider],
                    ] as const
                  ).map(([key, value]) =>
                    value ? (
                      <div key={key} className="flex gap-2">
                        <dt className="font-medium text-ink">{key}</dt>
                        <dd className="truncate">{value}</dd>
                      </div>
                    ) : null,
                  )}
                </dl>
              </div>

              <div className="rounded-xl border border-line bg-panel/80 p-3">
                <h3 className="text-sm font-semibold text-ink">Checkpoints</h3>
                <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                  {detail.checkpoints.map((cp) => (
                    <li key={cp.id}>
                      <span className="font-medium text-ink">{cp.kind}</span>
                      <span className="mx-1.5">·</span>
                      <span>{cp.label}</span>
                      <span className="mx-1.5">·</span>
                      <span>{new Date(cp.createdAt).toLocaleString()}</span>
                    </li>
                  ))}
                  {detail.checkpoints.length === 0 ? <li>No checkpoints.</li> : null}
                </ul>
              </div>

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
                <h3 className="text-sm font-semibold text-ink">AI requests</h3>
                <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                  {detail.aiRequests.map((req, index) => (
                    <li key={`${req.inputHash}-${index}`}>
                      <span className="font-medium text-ink">
                        {req.provider}/{req.model}
                      </span>
                      <span className="mx-1">·</span>
                      <span>{req.status}</span>
                      {req.promptVersion ? (
                        <>
                          <span className="mx-1">·</span>
                          <span>prompt v{req.promptVersion}</span>
                        </>
                      ) : null}
                      {req.capability ? (
                        <>
                          <span className="mx-1">·</span>
                          <span>{req.capability}</span>
                        </>
                      ) : null}
                    </li>
                  ))}
                  {detail.aiRequests.length === 0 ? <li>No AI request snapshots.</li> : null}
                </ul>
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
