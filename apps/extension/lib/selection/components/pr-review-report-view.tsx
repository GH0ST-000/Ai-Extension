import { useEffect, useMemo, useState } from 'react';
import type { PRReviewFinding, PRReviewReport } from '@project-x/types';

import { cn } from '~/lib/utils/cn';
import { extractPageContext } from '~/lib/context/extract-page-context';

import { activeDraftComments, useGithubReviewDraftStore } from '../review-draft';
import {
  filterPrFindings,
  type PrFindingDisposition,
  type PrFindingDispositionMap,
  type PrFindingFilter,
} from '../utils/build-pr-review-report';
import {
  buildPrReviewCommentDraft,
  buildPrReviewHandoffSummary,
} from '../utils/format-pr-review-markdown';
import { ReviewDraftChip, ReviewDraftPanel } from './review-draft-panel';

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
};

export function PrReviewReportView({
  report,
  streaming = false,
  filter,
  dispositions,
  onFilterChange,
  onSetDisposition,
  onSuggestFixForFinding,
  onCopySummary,
  onCopyCommentDraft,
  onPostComment,
  githubConnected = null,
}: PrReviewReportViewProps) {
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
    const ctx = extractPageContext();
    markStaleIfDestinationMismatch({
      owner: ctx.github?.owner,
      repository: ctx.github?.repository,
      pullRequestNumber: ctx.github?.pullRequestNumber,
    });
  }, [markStaleIfDestinationMismatch, report.pullRequest.number, report.repository.owner]);

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
    for (const comment of draft?.comments ?? []) {
      if (comment.findingId && !comment.removed) {
        ids.add(comment.findingId);
      }
    }
    return ids;
  }, [draft]);

  const activeDraftCount = draft ? activeDraftComments(draft).length : 0;
  const showDraftWorkspace = phase !== 'report';

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
        <ReviewDraftChip
          count={activeDraftCount}
          onOpen={() => {
            setPhase('editing');
          }}
        />
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
          {postedUrl ? (
            <>
              {' '}
              <a
                href={postedUrl}
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
                    {!ignored ? (
                      <button
                        type="button"
                        disabled={inDraft}
                        onClick={() => {
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

      {streaming ? <span className="inline-block text-[11px] text-accent">0</span> : null}
    </div>
  );
}
