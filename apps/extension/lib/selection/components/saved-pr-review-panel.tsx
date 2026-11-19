import { DOWNSTREAM_IMPACT_HEADING, renderDownstreamImpactSection } from '@project-x/shared';
import type { PageContext, PrReviewReportDetail } from '@project-x/types';
import { useMemo, useState } from 'react';

import { getDashboardAppUrl } from '../../workspace/dashboard-url';
import {
  buildPrReviewReport,
  type PrFindingDispositionMap,
  type PrFindingFilter,
} from '../utils/build-pr-review-report';
import { PrReviewReportView } from './pr-review-report-view';

/** PageContext for the existing report builder, from the saved snapshot (no page access). */
export function savedReviewContext(report: PrReviewReportDetail): PageContext {
  return {
    type: 'github',
    url: `https://github.com/${report.owner}/${report.repository}/pull/${report.pullRequestNumber}`,
    title: report.pullRequestTitle ?? '',
    github: {
      owner: report.owner,
      repository: report.repository,
      pullRequestNumber: report.pullRequestNumber,
      ...(report.pullRequestTitle ? { pullRequestTitle: report.pullRequestTitle } : {}),
      ...(report.baseBranch ? { baseBranch: report.baseBranch } : {}),
      ...(report.headBranch ? { headBranch: report.headBranch } : {}),
    },
  };
}

export function savedReviewMemoryLine(report: PrReviewReportDetail): string | null {
  const memory = report.snapshot.memory;
  if (!memory) return null;
  if (memory.mode === 'off') return 'Project Memory was off for this review.';
  if (memory.status !== 'applied') return 'Project Memory was not applied to this review.';
  const personal = memory.personalRuleCount
    ? ` (including ${memory.personalRuleCount} of your personal preferences)`
    : '';
  return `Project Memory: ${memory.ruleCount} rule${memory.ruleCount === 1 ? '' : 's'} applied${personal}.`;
}

function formatSavedAt(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

type SavedPrReviewPanelProps = {
  report: PrReviewReportDetail;
  workspaceId?: string | null;
  /** Label of the back action: returns to whatever was open before (menu or current review). */
  backLabel: string;
  onBack: () => void;
};

/**
 * A saved review, rendered with the same report view as a live review. Read-only: no
 * Suggest Fix, no GitHub comment posting; dispositions here are local to this view and do
 * not change the current review.
 */
export function SavedPrReviewPanel({
  report,
  workspaceId,
  backLabel,
  onBack,
}: SavedPrReviewPanelProps) {
  const [filter, setFilter] = useState<PrFindingFilter>('all');
  const [dispositions, setDispositions] = useState<PrFindingDispositionMap>({});
  const prReport = useMemo(() => {
    if (!report.reportMarkdown) return null;
    const built = buildPrReviewReport({
      markdown: report.reportMarkdown,
      context: savedReviewContext(report),
      scope: report.snapshot.reviewScope,
      final: true,
    });
    // The shared report Markdown never contains consumer names; the structured impact was
    // re-authorized for this viewer by the API, so it is rendered from the snapshot.
    const impact = report.snapshot.downstreamImpact
      ? renderDownstreamImpactSection(report.snapshot.downstreamImpact)
      : null;
    return built && impact
      ? { ...built, downstreamImpact: impact.slice(DOWNSTREAM_IMPACT_HEADING.length).trim() }
      : built;
  }, [report]);
  const memoryLine = savedReviewMemoryLine(report);
  const statusText =
    report.status === 'failed'
      ? 'This review failed — no report was produced and no usage was charged.'
      : report.status === 'partial'
        ? 'Partial review — some files were not fully reviewed.'
        : null;

  return (
    <div
      role="region"
      aria-label="Saved PR review"
      data-testid="saved-pr-review-panel"
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      style={{ width: 400 }}
      className="pointer-events-auto flex max-h-[460px] flex-col overflow-hidden rounded-panel border border-border px-panel-wash text-primary shadow-menu backdrop-blur-2xl"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-semibold tracking-[-0.02em] text-primary">
            Saved review · {report.owner}/{report.repository}#{report.pullRequestNumber}
          </p>
          <p className="text-[11px] text-muted">Saved {formatSavedAt(report.completedAt)}</p>
        </div>
        <button
          type="button"
          onClick={onBack}
          className="shrink-0 rounded-lg px-2 py-1 text-[11px] font-medium text-muted transition-colors hover:bg-hover hover:text-primary"
        >
          {backLabel}
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3.5 py-3">
        <p
          className="rounded-xl bg-icon px-2.5 py-2 text-[11.5px] leading-4 text-secondary"
          role="status"
        >
          Read-only snapshot{report.headSha ? ` of commit ${report.headSha.slice(0, 7)}` : ''}. The
          PR may have changed since. Opening it did not run the AI or use review credits.
        </p>
        {statusText ? (
          <p
            className="rounded-xl bg-amber-soft px-2.5 py-2 text-[11.5px] leading-4 text-amber"
            role="status"
          >
            {statusText}
          </p>
        ) : null}
        {memoryLine ? <p className="text-[11px] text-muted">{memoryLine}</p> : null}
        {prReport ? (
          <PrReviewReportView
            readOnly
            report={prReport}
            memory={null}
            filter={filter}
            dispositions={dispositions}
            onFilterChange={setFilter}
            onSetDisposition={(id, disposition) =>
              setDispositions((prev) => {
                const next = { ...prev };
                if (disposition) next[id] = disposition;
                else delete next[id];
                return next;
              })
            }
          />
        ) : report.status !== 'failed' ? (
          <p className="text-[12px] text-secondary">
            This report is too large to show here. Open it in the dashboard.
          </p>
        ) : null}
        <a
          href={getDashboardAppUrl(
            `/app/reviews?report=${encodeURIComponent(report.id)}`,
            workspaceId,
          )}
          target="_blank"
          rel="noreferrer"
          className="block text-[11px] font-semibold text-accent hover:underline"
        >
          Open review history in the dashboard
        </a>
      </div>
    </div>
  );
}
