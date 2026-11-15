import { useEffect, useMemo, useState } from 'react';
import type {
  PRReviewFinding,
  PRReviewReport,
  ProjectMemoryPromptMetadata,
} from '@project-x/types';

import { cn } from '~/lib/utils/cn';
import { extractPageContext } from '~/lib/context/extract-page-context';

import { activeDraftComments, useGithubReviewDraftStore } from '../review-draft';
import {
  filterPrFindings,
  formatFindingsCountLabel,
  formatReviewedFilesLabel,
  type PrFindingDisposition,
  type PrFindingDispositionMap,
  type PrFindingFilter,
} from '../utils/build-pr-review-report';
import {
  buildPrReviewCommentDraft,
  buildPrReviewHandoffSummary,
} from '../utils/format-pr-review-markdown';
import {
  coverageGaps,
  excludedCount,
  isUnverifiedPageScope,
  PAGE_FALLBACK_NOTICE,
  unreviewedFiles,
} from '../utils/pr-review-coverage';
import { ReviewDraftChip, ReviewDraftPanel } from './review-draft-panel';
import { PrReviewMemory } from './pr-review-memory';
import { safeHttpsHref } from '../ci/safe-external-url';

const STATUS_LABEL: Record<string, string> = {
  reviewed_partial: 'partial',
  deferred_budget: 'deferred',
  review_failed: 'failed',
  no_patch: 'no diff',
  not_fetched: 'not listed',
};
const MAX_LISTED_FILES = 50;

/** Diff collected from the GitHub page (API unavailable): coverage cannot be verified. */
function PageFallbackNotice({ report }: { report: PRReviewReport }) {
  if (!isUnverifiedPageScope(report.reviewScope)) {
    return null;
  }
  return (
    <div
      role="alert"
      data-testid="pr-review-page-fallback-notice"
      className="rounded-lg border border-spark/40 bg-spark/10 px-2.5 py-2 text-[11px] leading-4 text-primary"
    >
      <p className="font-semibold">Unverified coverage: diff read from the GitHub page.</p>
      <p className="mt-0.5 text-secondary">{PAGE_FALLBACK_NOTICE}</p>
    </div>
  );
}

/** Prominent partial-coverage notice: what was not reviewed, and why. */
function CoverageBanner({ report }: { report: PRReviewReport }) {
  const coverage = report.coverage;
  if (!coverage || coverage.complete) {
    return null;
  }
  const c = coverage.counts;
  const total = coverage.totalFiles ?? coverage.files.length + c.not_fetched;
  // Page fallback: the count is what the page showed, not the PR's real total.
  const ofTotal = isUnverifiedPageScope(coverage)
    ? `${total} file${total === 1 ? '' : 's'} found on the page`
    : `${total} changed files`;
  const gaps = coverageGaps(coverage);
  const files = unreviewedFiles(coverage);
  const failedBatches = coverage.batches.filter((b) => b.status !== 'succeeded').length;
  const excluded = excludedCount(coverage);
  const nothingReviewable = c.reviewed_full + c.reviewed_partial === 0 && gaps.length === 0;

  return (
    <div
      role="alert"
      data-testid="pr-review-coverage-banner"
      className="rounded-lg border border-spark/40 bg-spark/10 px-2.5 py-2 text-[11px] leading-4 text-primary"
    >
      <p className="font-semibold">
        {nothingReviewable
          ? 'No reviewable code changes — nothing was sent to AI.'
          : `Partial coverage: ${c.reviewed_full} of ${ofTotal} fully reviewed.`}
      </p>
      <p className="mt-0.5 text-secondary">
        {nothingReviewable
          ? 'Risk is not rated for this PR.'
          : 'Risk cannot be rated LOW while code is unreviewed. Review the files below yourself.'}
      </p>
      {gaps.length > 0 ? (
        <ul className="mt-1 list-disc pl-4 text-secondary">
          {gaps.map((gap) => (
            <li key={gap.status}>
              {gap.count} {gap.label}
            </li>
          ))}
          {failedBatches > 0 ? (
            <li>
              {failedBatches} of {coverage.batches.length} AI batches failed
            </li>
          ) : null}
        </ul>
      ) : null}
      {excluded > 0 ? (
        <p className="mt-1 text-muted">
          {excluded} generated, binary or rename-only file{excluded === 1 ? '' : 's'} excluded on
          purpose.
        </p>
      ) : null}
      {files.length > 0 ? (
        <details className="mt-1">
          <summary className="cursor-pointer font-semibold text-accent">
            Show {files.length} unreviewed file{files.length === 1 ? '' : 's'}
          </summary>
          <ul className="mt-1 space-y-0.5">
            {files.slice(0, MAX_LISTED_FILES).map((file) => (
              <li key={file.path} className="flex gap-1.5">
                <span className="shrink-0 rounded bg-hover px-1 text-[10px] text-muted">
                  {STATUS_LABEL[file.status] ?? file.status}
                </span>
                <span className="min-w-0 break-all font-mono text-secondary">{file.path}</span>
              </li>
            ))}
            {files.length > MAX_LISTED_FILES ? (
              <li className="text-muted">… and {files.length - MAX_LISTED_FILES} more</li>
            ) : null}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

const CHANGE_LABEL: Record<string, string> = {
  introduced: 'introduced by this PR',
  removed_safeguard: 'safeguard removed by this PR',
  exposed_existing: 'existing defect exposed by this PR',
  pre_existing: 'pre-existing (not from this PR)',
};

/** Why the finding stands: category, verification, and the trigger → failure → impact chain. */
function FindingDetails({ finding }: { finding: PRReviewFinding }) {
  const meta = [
    finding.category?.replace(/_/g, ' '),
    finding.confidence ? `${finding.confidence} confidence` : null,
    finding.changeType ? (CHANGE_LABEL[finding.changeType] ?? null) : null,
  ].filter(Boolean);
  const chain: [string, string | undefined][] = [
    ['Trigger', finding.trigger],
    ['Failure path', finding.failurePath],
    ['Impact', finding.impact],
  ];
  const hasChain = chain.some(([, v]) => v);
  if (!meta.length && !finding.verification && !hasChain && !finding.alsoIn?.length) {
    return null;
  }
  return (
    <div className="mt-1 space-y-0.5 text-[10px] leading-4 text-muted">
      {meta.length ? <p>{meta.join(' · ')}</p> : null}
      {finding.verification ? <p>Verification: {finding.verification}</p> : null}
      {finding.alsoIn?.length ? (
        <p className="break-all">Also in: {finding.alsoIn.join(', ')}</p>
      ) : null}
      {hasChain ? (
        <details>
          <summary className="cursor-pointer font-semibold text-accent">Failure path</summary>
          <dl className="mt-0.5 space-y-0.5">
            {chain
              .filter(([, v]) => v)
              .map(([label, value]) => (
                <div key={label}>
                  <dt className="inline font-semibold text-secondary">{label}: </dt>
                  <dd className="inline text-secondary">{value}</dd>
                </div>
              ))}
          </dl>
        </details>
      ) : null}
    </div>
  );
}

/** Unresolved MEDIUM/HIGH candidates: visible, clearly separated, never counted as findings. */
function NeedsInvestigation({ items }: { items: PRReviewFinding[] }) {
  if (items.length === 0) return null;
  return (
    <div data-testid="pr-review-needs-investigation" className="space-y-2">
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
        Needs investigation ({items.length})
      </p>
      <p className="text-[11px] leading-4 text-secondary">
        Possible issues that independent verification could neither confirm nor refute. They are not
        counted as findings, but the PR is not rated low risk while they remain open.
      </p>
      {items.map((item) => (
        <div
          key={item.id}
          className="rounded-lg border border-dashed border-spark/40 bg-surface px-2.5 py-2"
        >
          <p className="text-[11px] font-semibold text-primary">
            <span className="uppercase text-muted">possible {item.severity}</span>
            {item.filePath ? (
              <span className="font-mono font-medium text-secondary"> · {item.filePath}</span>
            ) : null}
          </p>
          <p className="mt-0.5 text-[12px] leading-4 text-primary">{item.title}</p>
          {item.why ? (
            <p className="mt-1 text-[11px] leading-4 text-secondary">{item.why}</p>
          ) : null}
          <FindingDetails finding={item} />
        </div>
      ))}
    </div>
  );
}

const FILTERS: { id: PrFindingFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'high', label: 'High' },
  { id: 'medium', label: 'Med' },
  { id: 'low', label: 'Low' },
  { id: 'open', label: 'Open' },
  { id: 'reviewed', label: 'Reviewed' },
  { id: 'ignored', label: 'Ignored' },
];

export type PostPrCommentResult = {
  ok: boolean;
  message?: string;
  commentUrl?: string;
};

type PrReviewReportViewProps = {
  report: PRReviewReport;
  /** Project memory applied to this review's prompt (from the API response). */
  memory?: ProjectMemoryPromptMetadata | null;
  streaming?: boolean;
  filter: PrFindingFilter;
  dispositions: PrFindingDispositionMap;
  onFilterChange: (filter: PrFindingFilter) => void;
  onSetDisposition: (findingId: string, disposition: PrFindingDisposition | null) => void;
  onSuggestFixForFinding?: (finding: PRReviewFinding) => void;
  onCopySummary?: () => Promise<boolean>;
  onCopyCommentDraft?: () => Promise<boolean>;
  onPostComment?: (body: string) => Promise<PostPrCommentResult>;
  githubConnected?: boolean | null;
  /**
   * Saved (historical) review: display only. Nothing here may change the live review, create
   * or edit a GitHub review draft, start an AI action or write to GitHub — Add to Review, the
   * draft chip / workspace, Suggest Fix and Post to GitHub are not rendered and the review
   * draft store is never written. Finding dispositions stay with the parent's callbacks.
   */
  readOnly?: boolean;
};

export function PrReviewReportView({
  report,
  memory = null,
  streaming = false,
  filter,
  dispositions,
  onFilterChange,
  onSetDisposition,
  onSuggestFixForFinding: onSuggestFixForFindingProp,
  onCopySummary,
  onCopyCommentDraft,
  onPostComment: onPostCommentProp,
  githubConnected = null,
  readOnly = false,
}: PrReviewReportViewProps) {
  // Read-only mode drops every action that can invoke AI or write to GitHub, whatever the
  // parent passed.
  const onSuggestFixForFinding = readOnly ? undefined : onSuggestFixForFindingProp;
  const onPostComment = readOnly ? undefined : onPostCommentProp;
  const [showHandoff, setShowHandoff] = useState(false);
  const [copiedSummary, setCopiedSummary] = useState(false);
  const [copiedComment, setCopiedComment] = useState(false);
  const [confirmPost, setConfirmPost] = useState(false);
  const [editableComment, setEditableComment] = useState('');
  const [posting, setPosting] = useState(false);
  const [postMessage, setPostMessage] = useState<string | null>(null);
  const [postError, setPostError] = useState<string | null>(null);
  const [postedUrl, setPostedUrl] = useState<string | null>(null);
  const [addMessage, setAddMessage] = useState<string | null>(null);

  const draft = useGithubReviewDraftStore((s) => s.draft);
  const phase = useGithubReviewDraftStore((s) => s.phase);
  const addFinding = useGithubReviewDraftStore((s) => s.addFinding);
  const setPhase = useGithubReviewDraftStore((s) => s.setPhase);
  const markStaleIfDestinationMismatch = useGithubReviewDraftStore(
    (s) => s.markStaleIfDestinationMismatch,
  );

  useEffect(() => {
    // The live review owns the draft; a saved review must not mark or otherwise change it.
    if (readOnly) {
      return;
    }
    const ctx = extractPageContext();
    markStaleIfDestinationMismatch({
      owner: ctx.github?.owner,
      repository: ctx.github?.repository,
      pullRequestNumber: ctx.github?.pullRequestNumber,
    });
  }, [
    markStaleIfDestinationMismatch,
    readOnly,
    report.pullRequest.number,
    report.repository.owner,
  ]);

  // Clear draft when a brand-new report destination appears after prior success cleanup
  useEffect(() => {
    if (!draft) {
      return;
    }
    if (
      draft.destination.owner !== report.repository.owner ||
      draft.destination.repository !== report.repository.name ||
      draft.destination.pullRequestNumber !== report.pullRequest.number
    ) {
      // Keep draft for stale protection; do not retarget.
      return;
    }
  }, [draft, report]);

  const visible = useMemo(
    () => filterPrFindings(report.findings, filter, dispositions),
    [report.findings, filter, dispositions],
  );
  const openCount = report.findings.filter((finding) => !dispositions[finding.id]).length;
  const incomplete = !streaming && report.completeness?.complete === false;
  const handoff = useMemo(
    () => buildPrReviewHandoffSummary(report, dispositions),
    [report, dispositions],
  );
  const commentDraft = useMemo(
    () => buildPrReviewCommentDraft(report, dispositions),
    [report, dispositions],
  );

  const draftFindingIds = useMemo(() => {
    const ids = new Set<string>();
    // A saved review is unrelated to the live draft, even when finding ids coincide.
    if (readOnly) {
      return ids;
    }
    for (const comment of draft?.comments ?? []) {
      if (comment.findingId && !comment.removed) {
        ids.add(comment.findingId);
      }
    }
    return ids;
  }, [draft, readOnly]);

  const activeDraftCount = draft ? activeDraftComments(draft).length : 0;
  const showDraftWorkspace = !readOnly && phase !== 'report';

  const canPost =
    Boolean(onPostComment) &&
    !streaming &&
    report.pullRequest.number > 0 &&
    report.repository.owner !== 'unknown' &&
    report.repository.name !== 'unknown';

  function openConfirmPost() {
    setEditableComment(commentDraft);
    setConfirmPost(true);
    setPostError(null);
    setPostMessage(null);
  }

  if (showDraftWorkspace) {
    return (
      <ReviewDraftPanel
        report={report}
        githubConnected={githubConnected}
        onBackToReport={() => setPhase('report')}
        onMarkFindingsReviewed={(findingIds) => {
          for (const id of findingIds) {
            if (!dispositions[id]) {
              onSetDisposition(id, 'reviewed');
            }
          }
        }}
      />
    );
  }

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
          {incomplete ? (
            <span className="shrink-0 rounded bg-spark/15 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-spark">
              incomplete
            </span>
          ) : (
            <span
              className={cn(
                'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                report.riskLevel === 'high'
                  ? 'bg-[#e11d48]/15 text-[#fb7185]'
                  : report.riskLevel === 'medium'
                    ? 'bg-spark/15 text-spark'
                    : report.riskLevel === 'unknown'
                      ? 'bg-hover text-muted'
                      : 'bg-accent-soft text-accent',
              )}
            >
              {report.riskLevel === 'unknown' && streaming ? 'reviewing…' : report.riskLevel}
            </span>
          )}
        </div>

        <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] text-muted">
          <span className="rounded bg-hover px-1.5 py-0.5">{formatFindingsCountLabel(report)}</span>
          <span className="rounded bg-hover px-1.5 py-0.5">{report.stats.high} high</span>
          <span className="rounded bg-hover px-1.5 py-0.5">{report.stats.medium} med</span>
          <span className="rounded bg-hover px-1.5 py-0.5">{report.stats.low} low</span>
          <span className="rounded bg-hover px-1.5 py-0.5">{formatReviewedFilesLabel(report)}</span>
          <span className="rounded bg-hover px-1.5 py-0.5">{openCount} open</span>
          {report.needsInvestigation?.length ? (
            <span className="rounded bg-hover px-1.5 py-0.5 font-semibold text-spark">
              {report.needsInvestigation.length} need investigation
            </span>
          ) : null}
          {report.coverage?.complete ? (
            <span className="rounded bg-hover px-1.5 py-0.5">full coverage</span>
          ) : report.reviewScope?.truncated ? (
            <span className="rounded bg-hover px-1.5 py-0.5 font-semibold text-spark">
              partial coverage
            </span>
          ) : null}
          {report.reviewScope?.source === 'page' ? (
            <span
              className="rounded bg-hover px-1.5 py-0.5"
              title="GitHub API unavailable; diff read from the page (total unknown)"
            >
              page diff
            </span>
          ) : null}
        </div>
      </div>

      {incomplete ? (
        <div
          role="alert"
          className="rounded-lg border border-spark/40 bg-spark/10 px-2.5 py-2 text-[11px] leading-4 text-primary"
        >
          <p className="font-semibold">
            This review is incomplete — do not treat it as a clean PR.
          </p>
          <ul className="mt-1 list-disc pl-4 text-secondary">
            {report.completeness!.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {!streaming ? <PageFallbackNotice report={report} /> : null}
      {!streaming ? <CoverageBanner report={report} /> : null}

      <PrReviewMemory metadata={memory} />

      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">Overview</p>
        <p className="mt-1 whitespace-pre-wrap break-words text-[12px] leading-4 text-primary">
          {report.overview || 'No overview.'}
        </p>
      </div>

      <div className="flex flex-wrap gap-1">
        {FILTERS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onFilterChange(item.id)}
            className={cn(
              'rounded-md px-2 py-1 text-[10px] font-semibold',
              filter === item.id
                ? 'bg-accent-soft text-accent'
                : 'text-secondary hover:bg-hover hover:text-primary',
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap gap-1">
        <button
          type="button"
          onClick={() => setShowHandoff((value) => !value)}
          className="rounded-md px-2 py-1 text-[10px] font-semibold text-secondary hover:bg-hover hover:text-primary"
        >
          {showHandoff ? 'Hide Summary' : 'Summary'}
        </button>
        {onCopySummary ? (
          <button
            type="button"
            onClick={async () => {
              const ok = await onCopySummary();
              if (ok) {
                setCopiedSummary(true);
                window.setTimeout(() => setCopiedSummary(false), 1500);
              }
            }}
            className="rounded-md px-2 py-1 text-[10px] font-semibold text-accent hover:bg-accent-soft"
          >
            {copiedSummary ? 'Copied Summary' : 'Copy Summary'}
          </button>
        ) : null}
        {onCopyCommentDraft ? (
          <button
            type="button"
            onClick={async () => {
              const ok = await onCopyCommentDraft();
              if (ok) {
                setCopiedComment(true);
                window.setTimeout(() => setCopiedComment(false), 1500);
              }
            }}
            className="rounded-md px-2 py-1 text-[10px] font-semibold text-accent hover:bg-accent-soft"
          >
            {copiedComment ? 'Copied Comment' : 'Copy Comment'}
          </button>
        ) : null}
        {canPost ? (
          <button
            type="button"
            onClick={openConfirmPost}
            className="rounded-md px-2 py-1 text-[10px] font-semibold text-accent hover:bg-accent-soft"
          >
            Post to GitHub
          </button>
        ) : null}
        {readOnly ? null : (
          <ReviewDraftChip
            count={activeDraftCount}
            onOpen={() => {
              setPhase('editing');
            }}
          />
        )}
      </div>

      {showHandoff ? (
        <pre className="mt-1 whitespace-pre-wrap break-words rounded-md border border-border bg-elevated px-2 py-1.5 font-sans text-[11px] leading-4 text-secondary">
          {handoff}
        </pre>
      ) : null}

      {confirmPost && onPostComment ? (
        <div className="rounded-lg border border-border bg-surface px-2.5 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
            Confirm PR comment
          </p>
          <p className="mt-1 text-[11px] leading-4 text-secondary">
            This will post the draft below as a comment on{' '}
            <span className="font-semibold text-primary">
              {report.repository.owner}/{report.repository.name}#{report.pullRequest.number}
            </span>
            . Your GitHub token stays on the API.
          </p>
          {githubConnected === false ? (
            <p className="mt-2 text-[11px] leading-4 text-[#e11d48]">
              No GitHub token connected. Open dashboard Settings → GitHub first.
            </p>
          ) : null}
          <textarea
            value={editableComment}
            onChange={(event) => setEditableComment(event.target.value)}
            rows={8}
            className="mt-2 w-full resize-y rounded-md border border-border bg-elevated px-2 py-1.5 font-sans text-[11px] leading-4 text-secondary outline-none focus:border-accent"
          />
          <div className="mt-2 flex flex-wrap gap-1">
            <button
              type="button"
              disabled={posting || githubConnected === false || !editableComment.trim()}
              onClick={async () => {
                setPosting(true);
                setPostError(null);
                setPostMessage(null);
                try {
                  const result = await onPostComment(editableComment);
                  if (!result.ok) {
                    setPostError(result.message ?? 'Unable to post comment.');
                    return;
                  }
                  setPostedUrl(result.commentUrl ?? null);
                  setPostMessage(result.message ?? 'Comment posted.');
                  setConfirmPost(false);
                } finally {
                  setPosting(false);
                }
              }}
              className="rounded-md bg-accent-soft px-2 py-1 text-[11px] font-semibold text-accent disabled:opacity-40"
            >
              {posting ? 'Posting…' : 'Confirm post'}
            </button>
            <button
              type="button"
              disabled={posting}
              onClick={() => setConfirmPost(false)}
              className="rounded-md px-2 py-1 text-[11px] font-medium text-secondary hover:bg-hover hover:text-primary disabled:opacity-40"
            >
              Cancel
            </button>
          </div>
          {postError ? <p className="mt-2 text-[11px] text-[#e11d48]">{postError}</p> : null}
        </div>
      ) : null}

      {postMessage ? (
        <p className="text-[11px] text-accent">
          {postMessage}
          {postedUrl && safeHttpsHref(postedUrl) ? (
            <>
              {' '}
              <a
                href={safeHttpsHref(postedUrl)!}
                target="_blank"
                rel="noreferrer"
                className="font-semibold underline-offset-2 hover:underline"
              >
                Open comment
              </a>
            </>
          ) : null}
        </p>
      ) : null}

      {addMessage ? <p className="text-[11px] text-accent">{addMessage}</p> : null}

      <div className="space-y-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
          Findings ({visible.length})
        </p>
        {visible.length === 0 ? (
          <p className="text-[12px] text-secondary">No findings in this filter.</p>
        ) : (
          visible.map((finding) => {
            const disposition = dispositions[finding.id];
            const inDraft = draftFindingIds.has(finding.id);
            const ignored = disposition === 'ignored';
            return (
              <div
                key={finding.id}
                className={cn(
                  'rounded-lg border border-border bg-surface px-2.5 py-2',
                  disposition && 'opacity-60',
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
                  {disposition ? (
                    <span className="ml-1 text-[10px] font-medium text-accent">{disposition}</span>
                  ) : null}
                  {inDraft ? (
                    <span className="ml-1 text-[10px] font-medium text-accent">in draft</span>
                  ) : null}
                </p>
                <p className="mt-0.5 text-[12px] leading-4 text-primary">{finding.title}</p>
                {finding.why ? (
                  <p className="mt-1 text-[11px] leading-4 text-secondary">{finding.why}</p>
                ) : null}
                {finding.lineStart != null ? (
                  <p className="mt-0.5 font-mono text-[10px] text-muted">
                    L{finding.lineStart}
                    {finding.lineEnd != null && finding.lineEnd !== finding.lineStart
                      ? `–L${finding.lineEnd}`
                      : ''}
                  </p>
                ) : null}
                <FindingDetails finding={finding} />
                {finding.evidence ? (
                  <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-elevated px-1.5 py-1 font-mono text-[10px] leading-4 text-secondary">
                    {finding.evidence}
                  </pre>
                ) : null}
                {!streaming ? (
                  <div className="mt-2 flex flex-wrap gap-1">
                    {disposition ? (
                      <button
                        type="button"
                        onClick={() => onSetDisposition(finding.id, null)}
                        className="rounded-md px-2 py-1 text-[11px] font-medium text-secondary hover:bg-hover hover:text-primary"
                      >
                        Reopen
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() => onSetDisposition(finding.id, 'reviewed')}
                          className="rounded-md px-2 py-1 text-[11px] font-medium text-secondary hover:bg-hover hover:text-primary"
                        >
                          Mark Reviewed
                        </button>
                        <button
                          type="button"
                          onClick={() => onSetDisposition(finding.id, 'ignored')}
                          className="rounded-md px-2 py-1 text-[11px] font-medium text-secondary hover:bg-hover hover:text-primary"
                        >
                          Ignore
                        </button>
                      </>
                    )}
                    {!ignored && !readOnly ? (
                      <button
                        type="button"
                        disabled={inDraft}
                        onClick={() => {
                          if (readOnly) return;
                          const result = addFinding(report, finding);
                          setAddMessage(
                            result.ok
                              ? 'Added to review draft.'
                              : (result.message ?? 'Could not add finding.'),
                          );
                          window.setTimeout(() => setAddMessage(null), 1800);
                        }}
                        className="rounded-md px-2 py-1 text-[11px] font-semibold text-accent hover:bg-accent-soft disabled:opacity-40"
                      >
                        {inDraft ? 'In Review' : 'Add to Review'}
                      </button>
                    ) : null}
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

      {!streaming ? <NeedsInvestigation items={report.needsInvestigation ?? []} /> : null}

      {streaming ? <span className="inline-block text-[11px] text-accent">0</span> : null}
    </div>
  );
}
