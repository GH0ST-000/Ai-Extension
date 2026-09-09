import { useMemo, useState } from 'react';
import type { PRReviewFinding, PRReviewReport } from '@project-x/types';

import { cn } from '~/lib/utils/cn';

import { filterPrFindings, type PrFindingFilter } from '../utils/build-pr-review-report';
import { buildPrReviewHandoffSummary } from '../utils/format-pr-review-markdown';

const FILTERS: { id: PrFindingFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'high', label: 'High' },
  { id: 'medium', label: 'Med' },
  { id: 'low', label: 'Low' },
  { id: 'open', label: 'Open' },
];

type PrReviewReportViewProps = {
  report: PRReviewReport;
  streaming?: boolean;
  filter: PrFindingFilter;
  resolvedIds: ReadonlySet<string>;
  onFilterChange: (filter: PrFindingFilter) => void;
  onToggleResolved: (findingId: string) => void;
  onSuggestFixForFinding?: (finding: PRReviewFinding) => void;
};

export function PrReviewReportView({
  report,
  streaming = false,
  filter,
  resolvedIds,
  onFilterChange,
  onToggleResolved,
  onSuggestFixForFinding,
}: PrReviewReportViewProps) {
  const [showHandoff, setShowHandoff] = useState(false);
  const visible = useMemo(
    () => filterPrFindings(report.findings, filter, resolvedIds),
    [report.findings, filter, resolvedIds],
  );
  const openCount = report.findings.filter((finding) => !resolvedIds.has(finding.id)).length;
  const handoff = useMemo(
    () => buildPrReviewHandoffSummary(report, resolvedIds),
    [report, resolvedIds],
  );

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-border bg-surface/80 px-2.5 py-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-[11px] font-semibold text-primary">
              {report.repository.owner}/{report.repository.name}
              {report.pullRequest.number > 0 ? ` · #${report.pullRequest.number}` : ''}
            </p>
            {report.pullRequest.title ? (
              <p className="mt-0.5 truncate text-[11px] text-secondary">
                {report.pullRequest.title}
              </p>
            ) : null}
          </div>
          <span
            className={cn(
              'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide',
              report.riskLevel === 'high'
                ? 'bg-[#e11d48]/15 text-[#fb7185]'
                : report.riskLevel === 'medium'
                  ? 'bg-spark/15 text-spark'
                  : 'bg-accent-soft text-accent',
            )}
          >
            {report.riskLevel}
          </span>
        </div>

        <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] text-muted">
          <span className="rounded bg-hover px-1.5 py-0.5">{report.stats.findings} findings</span>
          <span className="rounded bg-hover px-1.5 py-0.5">{report.stats.high} high</span>
          <span className="rounded bg-hover px-1.5 py-0.5">{report.stats.medium} med</span>
          <span className="rounded bg-hover px-1.5 py-0.5">{report.stats.low} low</span>
          <span className="rounded bg-hover px-1.5 py-0.5">{report.stats.analyzedFiles} files</span>
          <span className="rounded bg-hover px-1.5 py-0.5">{openCount} open</span>
          {report.reviewScope?.truncated ? (
            <span className="rounded bg-hover px-1.5 py-0.5">truncated</span>
          ) : null}
        </div>
      </div>

      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">Overview</p>
        <p className="mt-1 whitespace-pre-wrap break-words text-[12px] leading-4 text-primary">
          {report.overview}
        </p>
      </div>

      {showHandoff ? (
        <div className="rounded-lg border border-border bg-surface px-2.5 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
            Review summary
          </p>
          <pre className="mt-1 whitespace-pre-wrap break-words font-sans text-[11px] leading-4 text-secondary">
            {handoff}
          </pre>
        </div>
      ) : null}

      <div className="flex flex-wrap gap-1">
        {FILTERS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onFilterChange(item.id)}
            className={cn(
              'rounded-md px-2 py-1 text-[10px] font-semibold transition',
              filter === item.id
                ? 'bg-accent-soft text-accent'
                : 'text-muted hover:bg-hover hover:text-primary',
            )}
          >
            {item.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setShowHandoff((value) => !value)}
          className="rounded-md px-2 py-1 text-[10px] font-semibold text-muted hover:bg-hover hover:text-primary"
        >
          {showHandoff ? 'Hide summary' : 'Summary'}
        </button>
      </div>

      <div className="space-y-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
          Findings ({visible.length})
        </p>
        {visible.length === 0 ? (
          <p className="text-[12px] text-secondary">No findings in this filter.</p>
        ) : (
          visible.map((finding) => {
            const resolved = resolvedIds.has(finding.id);
            return (
              <div
                key={finding.id}
                className={cn(
                  'rounded-lg border border-border bg-surface px-2.5 py-2',
                  resolved && 'opacity-60',
                )}
              >
                <p className="text-[11px] font-semibold text-primary">
                  <span className="uppercase text-muted">{finding.severity}</span>
                  {finding.filePath ? (
                    <span className="font-mono font-medium text-secondary">
                      {' '}
                      · {finding.filePath}
                    </span>
                  ) : null}
                  {resolved ? (
                    <span className="ml-1 text-[10px] font-medium text-accent">resolved</span>
                  ) : null}
                </p>
                <p className="mt-0.5 text-[12px] leading-4 text-primary">{finding.title}</p>
                {finding.why ? (
                  <p className="mt-1 text-[11px] leading-4 text-secondary">{finding.why}</p>
                ) : null}
                {!streaming ? (
                  <div className="mt-2 flex flex-wrap gap-1">
                    <button
                      type="button"
                      onClick={() => onToggleResolved(finding.id)}
                      className="rounded-md px-2 py-1 text-[11px] font-medium text-secondary hover:bg-hover hover:text-primary"
                    >
                      {resolved ? 'Reopen' : 'Resolve'}
                    </button>
                    {onSuggestFixForFinding ? (
                      <button
                        type="button"
                        onClick={() => onSuggestFixForFinding(finding)}
                        className="rounded-md px-2 py-1 text-[11px] font-semibold text-accent hover:bg-accent-soft"
                      >
                        Suggest Fix
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>

      {streaming ? <span className="inline-block text-[11px] text-accent">0</span> : null}
    </div>
  );
}
