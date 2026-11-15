'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  PrReviewHistoryItem,
  PrReviewReportDetail,
  PrReviewReportFinding,
  PrReviewReportStatus,
} from '@project-x/types';
import { normalizeError } from '@project-x/shared';

import { EmptyState } from '../../../components/empty-state';
import { notify } from '../../../lib/notify';
import { useWorkspace } from '../../../lib/workspace-context';
import {
  STATUS_LABELS,
  buildHistoryMarkdown,
  coverageLabel,
  failureLabel,
  findingsLabel,
  formatDateTime,
  getPrReviewReport,
  historyExportFilename,
  loadHistoryPage,
  parsePullRequestFilter,
  parseRepositoryFilter,
} from './reviews-data';

const PAGE_SIZE = 20;

const STATUS_STYLES: Record<PrReviewReportStatus, string> = {
  completed: 'border-accent bg-accent-soft text-ink',
  partial: 'border-amber-500/50 bg-amber-500/10 text-ink',
  failed: 'border-red-500/50 bg-red-500/10 text-ink',
};

type Filters = { repo: string; pr: string; status: '' | PrReviewReportStatus };

function StatusBadge({ status }: { status: PrReviewReportStatus }) {
  return (
    <span
      className={[
        'shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold',
        STATUS_STYLES[status],
      ].join(' ')}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

function ReviewsPageInner() {
  const { currentWorkspaceId, workspaceRevision, ready } = useWorkspace();
  const router = useRouter();
  const pathname = usePathname() ?? '/app/reviews';
  const searchParams = useSearchParams();
  const selectedId = searchParams?.get('report') ?? null;

  // Filters live in the URL so opening a report and coming back keeps them.
  const filters: Filters = {
    repo: searchParams?.get('repo') ?? '',
    pr: searchParams?.get('pr') ?? '',
    status:
      (['completed', 'partial', 'failed'] as const).find(
        (s) => s === searchParams?.get('status'),
      ) ?? '',
  };
  const [draft, setDraft] = useState<Filters>(filters);
  const [filterError, setFilterError] = useState<string | null>(null);

  const [items, setItems] = useState<PrReviewHistoryItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [someHidden, setSomeHidden] = useState(false);
  const [accessIncomplete, setAccessIncomplete] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [detail, setDetail] = useState<PrReviewReportDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const listScroll = useRef(0);

  const query = useMemo(() => {
    const repo = filters.repo ? parseRepositoryFilter(filters.repo) : null;
    const pr = filters.pr ? parsePullRequestFilter(filters.pr) : null;
    return {
      ...(repo ?? {}),
      ...(repo && pr ? { pullRequestNumber: pr } : {}),
      ...(filters.status ? { status: filters.status } : {}),
    };
  }, [filters.repo, filters.pr, filters.status]);

  const setParams = useCallback(
    (patch: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams?.toString() ?? '');
      for (const [key, value] of Object.entries(patch)) {
        if (value) params.set(key, value);
        else params.delete(key);
      }
      const qs = params.toString();
      router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  // List: reload when the workspace or the filters change.
  useEffect(() => {
    if (!ready || !currentWorkspaceId) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    loadHistoryPage(currentWorkspaceId, { ...query, limit: PAGE_SIZE }, controller.signal)
      .then((page) => {
        setItems(page.items);
        setNextCursor(page.nextCursor);
        setSomeHidden(page.someRepositoriesHidden);
        setAccessIncomplete(page.accessCheckIncomplete);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(normalizeError(err, 'Unable to load review history.').message);
        setItems([]);
        setNextCursor(null);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [ready, currentWorkspaceId, workspaceRevision, query]);

  // Detail: a saved snapshot only — never re-runs the review.
  useEffect(() => {
    if (!selectedId || !currentWorkspaceId) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    const controller = new AbortController();
    setDetailLoading(true);
    setDetailError(null);
    getPrReviewReport(currentWorkspaceId, selectedId, controller.signal)
      .then(setDetail)
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setDetail(null);
        setDetailError(normalizeError(err, 'Unable to open this review.').message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailLoading(false);
      });
    return () => controller.abort();
  }, [selectedId, currentWorkspaceId, workspaceRevision]);

  async function loadMore() {
    if (!currentWorkspaceId || !nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await loadHistoryPage(currentWorkspaceId, {
        ...query,
        limit: PAGE_SIZE,
        cursor: nextCursor,
      });
      setItems((prev) => [...prev, ...page.items.filter((i) => !prev.some((p) => p.id === i.id))]);
      setNextCursor(page.nextCursor);
      setSomeHidden((prev) => prev || page.someRepositoriesHidden);
      setAccessIncomplete(page.accessCheckIncomplete);
    } catch (err) {
      notify.apiError('Could not load more reviews', err);
    } finally {
      setLoadingMore(false);
    }
  }

  function applyFilters(event: React.FormEvent) {
    event.preventDefault();
    const repo = draft.repo.trim();
    const pr = draft.pr.trim();
    if (repo && !parseRepositoryFilter(repo)) {
      setFilterError('Repository must look like owner/repo.');
      return;
    }
    if (pr && !repo) {
      setFilterError('Choose a repository to filter by pull request number.');
      return;
    }
    if (pr && parsePullRequestFilter(pr) === null) {
      setFilterError('Pull request must be a number.');
      return;
    }
    setFilterError(null);
    setParams({ repo: repo || null, pr: pr || null, status: draft.status || null, report: null });
  }

  function clearFilters() {
    setDraft({ repo: '', pr: '', status: '' });
    setFilterError(null);
    setParams({ repo: null, pr: null, status: null, report: null });
  }

  function openReport(id: string) {
    listScroll.current = typeof window !== 'undefined' ? window.scrollY : 0;
    setParams({ report: id });
  }

  function closeReport() {
    setParams({ report: null });
    if (typeof window !== 'undefined') {
      requestAnimationFrame(() => window.scrollTo({ top: listScroll.current }));
    }
  }

  function exportMarkdown(report: PrReviewReportDetail) {
    const blob = new Blob([buildHistoryMarkdown(report)], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = historyExportFilename(report);
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    notify.success('Markdown exported', historyExportFilename(report));
  }

  const hasFilters = Boolean(filters.repo || filters.pr || filters.status);

  if (selectedId) {
    return (
      <div className="mx-auto max-w-5xl space-y-5">
        <button
          type="button"
          onClick={closeReport}
          className="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-ink"
        >
          ← Back to review history
        </button>
        {detailLoading && !detail ? (
          <p className="text-sm text-muted-foreground" role="status">
            Loading saved review…
          </p>
        ) : null}
        {detailError ? (
          <div
            role="alert"
            className="rounded-xl border border-line bg-panel px-4 py-3 text-sm text-ink"
          >
            {detailError}
          </div>
        ) : null}
        {detail ? <ReportDetail report={detail} onExport={() => exportMarkdown(detail)} /> : null}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Review history</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Saved PR reviews for this workspace. Opening a saved review shows the snapshot taken when
          it finished — it does not run the AI again, use review credits, or post to GitHub.
        </p>
      </header>

      <form
        onSubmit={applyFilters}
        className="flex flex-wrap items-end gap-3 rounded-2xl border border-line bg-panel/70 p-3"
        aria-label="Filter review history"
      >
        <label className="flex min-w-[12rem] flex-1 flex-col gap-1 text-xs font-medium text-ink">
          Repository
          <input
            value={draft.repo}
            onChange={(e) => setDraft({ ...draft, repo: e.target.value })}
            placeholder="owner/repo"
            className="rounded-lg border border-line bg-panel px-2.5 py-1.5 text-sm"
          />
        </label>
        <label className="flex w-28 flex-col gap-1 text-xs font-medium text-ink">
          Pull request
          <input
            value={draft.pr}
            onChange={(e) => setDraft({ ...draft, pr: e.target.value })}
            placeholder="#123"
            inputMode="numeric"
            className="rounded-lg border border-line bg-panel px-2.5 py-1.5 text-sm"
          />
        </label>
        <label className="flex w-36 flex-col gap-1 text-xs font-medium text-ink">
          Status
          <select
            value={draft.status}
            onChange={(e) => setDraft({ ...draft, status: e.target.value as Filters['status'] })}
            className="rounded-lg border border-line bg-panel px-2.5 py-1.5 text-sm"
          >
            <option value="">All</option>
            <option value="completed">Complete</option>
            <option value="partial">Partial</option>
            <option value="failed">Failed</option>
          </select>
        </label>
        <div className="flex gap-2">
          <button
            type="submit"
            className="rounded-lg bg-ink px-3 py-1.5 text-xs font-semibold text-inverse"
          >
            Apply
          </button>
          {hasFilters ? (
            <button
              type="button"
              onClick={clearFilters}
              className="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-ink"
            >
              Clear
            </button>
          ) : null}
        </div>
        {filterError ? (
          <p role="alert" className="w-full text-xs text-ink">
            {filterError}
          </p>
        ) : null}
      </form>

      {error ? (
        <div
          role="alert"
          className="rounded-xl border border-line bg-panel px-4 py-3 text-sm text-ink"
        >
          {error}
        </div>
      ) : null}

      {loading && items.length === 0 ? (
        <p className="text-sm text-muted-foreground" role="status">
          Loading review history…
        </p>
      ) : null}

      {!loading && !error && items.length === 0 && !nextCursor ? (
        <EmptyState
          title={hasFilters ? 'No saved reviews match' : 'No saved reviews yet'}
          description={
            hasFilters
              ? 'Try another repository, pull request or status.'
              : 'Run “Review entire PR” from the extension on a GitHub pull request. Finished reviews are saved here automatically.'
          }
        />
      ) : null}

      {items.length > 0 ? (
        <ul className="space-y-2" aria-label="Saved reviews">
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => openReport(item.id)}
                className="w-full rounded-xl border border-line bg-panel/70 px-3 py-2.5 text-left transition hover:bg-panel"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-semibold text-ink">
                    {item.owner}/{item.repository}#{item.pullRequestNumber}
                    {item.pullRequestTitle ? (
                      <span className="font-normal text-muted-foreground">
                        {' '}
                        — {item.pullRequestTitle}
                      </span>
                    ) : null}
                  </span>
                  <StatusBadge status={item.status} />
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
                  <span>{formatDateTime(item.completedAt)}</span>
                  <span>{findingsLabel(item)}</span>
                  <span>{coverageLabel(item)}</span>
                  {item.riskLevel ? <span>risk {item.riskLevel}</span> : null}
                  <span>
                    {item.initiatedByMe
                      ? 'by you'
                      : item.initiatorName
                        ? `by ${item.initiatorName}`
                        : 'by a teammate'}
                  </span>
                </div>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {nextCursor ? (
        <button
          type="button"
          onClick={() => void loadMore()}
          disabled={loadingMore}
          className="rounded-lg border border-line px-3 py-1.5 text-xs font-semibold text-ink disabled:opacity-40"
        >
          {loadingMore ? 'Loading…' : accessIncomplete ? 'Try loading more' : 'Load more'}
        </button>
      ) : null}

      {accessIncomplete ? (
        <p role="status" className="text-xs text-muted-foreground">
          GitHub could not confirm access to some repositories right now, so older reviews are not
          shown yet. Try loading more in a moment.
        </p>
      ) : null}

      {someHidden ? (
        <p className="text-xs text-muted-foreground">
          Some reviews are hidden because your GitHub access (or the workspace GitHub App) does not
          currently include their repository.
        </p>
      ) : null}
    </div>
  );
}

function FindingCard({ finding }: { finding: PrReviewReportFinding }) {
  const lines =
    finding.lineStart !== null
      ? `:${finding.lineStart}${finding.lineEnd && finding.lineEnd !== finding.lineStart ? `-${finding.lineEnd}` : ''}`
      : '';
  return (
    <li className="rounded-xl border border-line bg-panel/80 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full border border-line px-2 py-0.5 text-[10px] font-semibold uppercase text-ink">
          {finding.severity}
        </span>
        <span className="text-sm font-semibold text-ink">{finding.title}</span>
      </div>
      <p className="mt-1 font-mono text-[11px] text-muted-foreground">
        {finding.path}
        {lines} · {finding.category} · confidence {finding.confidence}
        {finding.verification.status !== 'not_required'
          ? ` · verification ${finding.verification.status}`
          : ''}
      </p>
      <p className="mt-2 whitespace-pre-wrap text-sm text-ink">{finding.explanation}</p>
      {finding.impact ? (
        <p className="mt-2 text-xs text-muted-foreground">
          <span className="font-semibold text-ink">Impact:</span> {finding.impact}
        </p>
      ) : null}
      {finding.evidence ? (
        <pre className="mt-2 overflow-x-auto rounded-lg bg-mist p-2 text-[11px] text-ink">
          {finding.evidence}
        </pre>
      ) : null}
      {finding.alsoIn.length > 0 ? (
        <p className="mt-1 text-[11px] text-muted-foreground">
          Also in: {finding.alsoIn.join(', ')}
        </p>
      ) : null}
    </li>
  );
}

function ReportDetail({
  report,
  onExport,
}: {
  report: PrReviewReportDetail;
  onExport: () => void;
}) {
  const reported = report.snapshot.findings.filter((f) => f.disposition === 'reported');
  const investigate = report.snapshot.findings.filter(
    (f) => f.disposition === 'needs_investigation',
  );
  const coverage = report.snapshot.coverage;
  const uncovered = coverage
    ? coverage.files.filter(
        (f) =>
          ![
            'reviewed_full',
            'excluded_generated',
            'excluded_binary',
            'excluded_no_changes',
          ].includes(f.status),
      )
    : [];
  const failure = failureLabel(report.snapshot.failure?.code ?? report.failureCode);
  const memory = report.snapshot.memory;

  return (
    <article className="space-y-5" aria-label="Saved review">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold tracking-tight text-ink">
            {report.owner}/{report.repository}#{report.pullRequestNumber}
          </h1>
          <StatusBadge status={report.status} />
        </div>
        {report.pullRequestTitle ? (
          <p className="text-sm text-ink">{report.pullRequestTitle}</p>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Saved review from {formatDateTime(report.completedAt)} ·{' '}
          {report.initiatedByMe
            ? 'run by you'
            : report.initiatorName
              ? `run by ${report.initiatorName}`
              : 'run by a teammate'}
          {report.headSha ? ` · head ${report.headSha.slice(0, 7)}` : ''}
        </p>
        <p className="rounded-lg border border-line bg-mist px-3 py-2 text-xs text-muted-foreground">
          This is a read-only snapshot. The pull request may have changed since; run a new review
          from the extension to review the current code.
        </p>
        <div>
          <button
            type="button"
            onClick={onExport}
            className="rounded-lg bg-ink px-3 py-1.5 text-xs font-semibold text-inverse"
          >
            Export Markdown
          </button>
        </div>
      </header>

      {failure ? (
        <p
          role="status"
          className={[
            'rounded-xl border px-3 py-2 text-sm text-ink',
            STATUS_STYLES[report.status === 'failed' ? 'failed' : 'partial'],
          ].join(' ')}
        >
          {failure}
        </p>
      ) : null}

      <dl className="grid gap-3 sm:grid-cols-4">
        {(
          [
            ['Findings', String(report.findingsCount)],
            ['To investigate', String(report.needsInvestigationCount)],
            ['Coverage', `${coverageLabel(report)}${report.coverageComplete ? ' · complete' : ''}`],
            ['Risk', report.riskLevel ?? '—'],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="rounded-xl border border-line bg-panel/80 p-3">
            <dt className="text-[11px] font-medium text-muted-foreground">{label}</dt>
            <dd className="mt-1 text-sm font-semibold text-ink">{value}</dd>
          </div>
        ))}
      </dl>

      {memory ? (
        <p className="text-xs text-muted-foreground">
          Project Memory:{' '}
          {memory.mode === 'off'
            ? 'off for this review'
            : memory.status === 'applied'
              ? `${memory.ruleCount} rule${memory.ruleCount === 1 ? '' : 's'} applied${
                  memory.personalRuleCount
                    ? ` (including ${memory.personalRuleCount} of your personal preferences)`
                    : ''
                }`
              : memory.status === 'skipped'
                ? 'not applied'
                : memory.status}
        </p>
      ) : null}

      {report.status !== 'failed' ? (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-ink">Findings</h2>
          {reported.length === 0 ? (
            <p className="text-sm text-muted-foreground">No findings were reported.</p>
          ) : (
            <ul className="space-y-2">
              {reported.map((f) => (
                <FindingCard key={f.stableId} finding={f} />
              ))}
            </ul>
          )}
        </section>
      ) : null}

      {investigate.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-ink">Needs investigation</h2>
          <ul className="space-y-2">
            {investigate.map((f) => (
              <FindingCard key={f.stableId} finding={f} />
            ))}
          </ul>
        </section>
      ) : null}

      {uncovered.length > 0 ? (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-ink">Not fully reviewed</h2>
          <ul className="space-y-1 text-xs text-muted-foreground">
            {uncovered.slice(0, 200).map((f) => (
              <li key={f.path} className="font-mono">
                {f.path} — {f.status.replace(/_/g, ' ')}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </article>
  );
}

export default function ReviewHistoryPage() {
  return (
    <Suspense fallback={<p className="text-sm text-muted-foreground">Loading review history…</p>}>
      <ReviewsPageInner />
    </Suspense>
  );
}
