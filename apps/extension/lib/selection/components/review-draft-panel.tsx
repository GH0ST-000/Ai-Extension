import { useEffect, useMemo, useState } from 'react';
import type {
  GitHubReviewEvent,
  GitHubReviewSubmissionSnapshot,
  PRReviewFinding,
  PRReviewReport,
} from '@project-x/types';
import { GITHUB_REVIEW_EVENTS } from '@project-x/types';

import { cn } from '~/lib/utils/cn';
import { GithubApiError, submitPullRequestReview } from '~/lib/services/github-api';
import { extractPageContext } from '~/lib/context/extract-page-context';

import {
  activeDraftComments,
  createClientRequestId,
  createReviewSubmissionSnapshot,
  reviewEventCtaLabel,
  snapshotToSubmitRequest,
  useGithubReviewDraftStore,
  validateReviewDraft,
} from '../review-draft';

type ReviewDraftPanelProps = {
  report: PRReviewReport;
  githubConnected?: boolean | null;
  onBackToReport: () => void;
  onMarkFindingsReviewed?: (findingIds: string[]) => void;
};

export function ReviewDraftPanel({
  report,
  githubConnected = null,
  onBackToReport,
  onMarkFindingsReviewed,
}: ReviewDraftPanelProps) {
  const draft = useGithubReviewDraftStore((s) => s.draft);
  const snapshot = useGithubReviewDraftStore((s) => s.snapshot);
  const phase = useGithubReviewDraftStore((s) => s.phase);
  const submitResult = useGithubReviewDraftStore((s) => s.submitResult);
  const submitError = useGithubReviewDraftStore((s) => s.submitError);
  const submitErrorCode = useGithubReviewDraftStore((s) => s.submitErrorCode);
  const removeComment = useGithubReviewDraftStore((s) => s.removeComment);
  const restoreComment = useGithubReviewDraftStore((s) => s.restoreComment);
  const setCommentBody = useGithubReviewDraftStore((s) => s.setCommentBody);
  const setOverallBody = useGithubReviewDraftStore((s) => s.setOverallBody);
  const setEvent = useGithubReviewDraftStore((s) => s.setEvent);
  const setPhase = useGithubReviewDraftStore((s) => s.setPhase);
  const setSnapshot = useGithubReviewDraftStore((s) => s.setSnapshot);
  const setSubmitResult = useGithubReviewDraftStore((s) => s.setSubmitResult);
  const setSubmitError = useGithubReviewDraftStore((s) => s.setSubmitError);
  const markStaleIfDestinationMismatch = useGithubReviewDraftStore(
    (s) => s.markStaleIfDestinationMismatch,
  );
  const resetSubmissionUi = useGithubReviewDraftStore((s) => s.resetSubmissionUi);

  const [localError, setLocalError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const ctx = extractPageContext();
    markStaleIfDestinationMismatch({
      owner: ctx.github?.owner,
      repository: ctx.github?.repository,
      pullRequestNumber: ctx.github?.pullRequestNumber,
    });
  }, [markStaleIfDestinationMismatch, report.pullRequest.number]);

  const active = useMemo(() => (draft ? activeDraftComments(draft) : []), [draft]);
  const removed = useMemo(
    () => draft?.comments.filter((comment) => comment.removed) ?? [],
    [draft],
  );

  if (!draft) {
    return (
      <div className="rounded-lg border border-border bg-surface px-2.5 py-2 text-[12px] text-secondary">
        No review draft yet. Add a finding from the report.
      </div>
    );
  }

  const currentDraft = draft;

  async function handlePreview() {
    setLocalError(null);
    const validation = validateReviewDraft(currentDraft);
    if (!validation.ok) {
      setLocalError(validation.message);
      return;
    }
    const nextSnapshot = await createReviewSubmissionSnapshot(
      currentDraft,
      createClientRequestId(),
    );
    setSnapshot(nextSnapshot);
    setSubmitError(null);
    setSubmitResult(null);
    setPhase('confirming');
  }

  async function handleSubmit(current: GitHubReviewSubmissionSnapshot) {
    setPhase('submitting');
    setSubmitError(null);
    try {
      const result = await submitPullRequestReview(
        current.owner,
        current.repository,
        current.pullRequestNumber,
        snapshotToSubmitRequest(current),
      );
      setSubmitResult(result);
      setPhase('success');
      const findingIds = active
        .map((comment) => comment.findingId)
        .filter((id): id is string => Boolean(id));
      onMarkFindingsReviewed?.(findingIds);
    } catch (error) {
      const message =
        error instanceof GithubApiError ? error.message : 'Unable to submit the review.';
      const code = error instanceof GithubApiError ? error.code : null;
      setSubmitError(message, code);
      if (code === 'WRITE_OUTCOME_UNKNOWN') {
        setPhase('uncertain');
      } else {
        setPhase('error');
      }
    }
  }

  async function handleCopyPayload() {
    const text = snapshot
      ? [
          `Event: ${snapshot.event}`,
          `PR: ${snapshot.owner}/${snapshot.repository}#${snapshot.pullRequestNumber}`,
          '',
          snapshot.body,
          '',
          ...snapshot.comments.map(
            (comment, index) =>
              `Comment ${index + 1}${comment.path ? ` (${comment.path}:${comment.line})` : ''}:\n${comment.body}`,
          ),
        ].join('\n')
      : [
          `Event: ${currentDraft.event}`,
          `PR: ${currentDraft.destination.owner}/${currentDraft.destination.repository}#${currentDraft.destination.pullRequestNumber}`,
          '',
          currentDraft.body,
          '',
          ...active.map((comment) => `• ${comment.body}`),
        ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  if (phase === 'success' && submitResult) {
    return (
      <div className="space-y-3">
        <div className="rounded-lg border border-border bg-surface px-2.5 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-accent">
            Review submitted
          </p>
          <p className="mt-1 text-[12px] text-primary">
            {draft.event} · {submitResult.commentCount} comment
            {submitResult.commentCount === 1 ? '' : 's'}
            {submitResult.deduplicated ? ' · replayed' : ''}
          </p>
          <div className="mt-2 flex flex-wrap gap-1">
            {submitResult.reviewUrl ? (
              <a
                href={submitResult.reviewUrl}
                target="_blank"
                rel="noreferrer"
                className="rounded-md bg-accent-soft px-2 py-1 text-[11px] font-semibold text-accent"
              >
                View on GitHub
              </a>
            ) : null}
            <button
              type="button"
              onClick={() => {
                setPhase('report');
                onBackToReport();
              }}
              className="rounded-md px-2 py-1 text-[11px] font-medium text-secondary hover:bg-hover hover:text-primary"
            >
              Back to Report
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (
    phase === 'confirming' ||
    phase === 'submitting' ||
    phase === 'uncertain' ||
    phase === 'error'
  ) {
    const preview = snapshot;
    return (
      <div className="space-y-3">
        <div className="rounded-lg border border-border bg-surface px-2.5 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
            Confirm GitHub review
          </p>
          {preview ? (
            <>
              <p className="mt-1 text-[11px] text-secondary">
                <span className="font-semibold text-primary">
                  {preview.owner}/{preview.repository}#{preview.pullRequestNumber}
                </span>
                {' · '}
                <span className="font-semibold text-primary">{preview.event}</span>
              </p>
              <pre className="mt-2 max-h-36 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border bg-elevated px-2 py-1.5 font-sans text-[11px] leading-4 text-secondary">
                {preview.body || '_empty overall body_'}
              </pre>
              {preview.comments.length > 0 ? (
                <ul className="mt-2 space-y-1.5">
                  {preview.comments.map((comment, index) => (
                    <li
                      key={`${comment.path}-${comment.line}-${index}`}
                      className="rounded-md border border-border bg-elevated px-2 py-1.5 text-[11px] text-secondary"
                    >
                      <p className="font-mono text-[10px] text-muted">
                        {comment.path}:{comment.line} ({comment.side})
                      </p>
                      <p className="mt-0.5 whitespace-pre-wrap break-words">{comment.body}</p>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-[11px] text-muted">
                  No inline comments — PR-level notes are in the overall body.
                </p>
              )}
            </>
          ) : null}

          {githubConnected === false ? (
            <p className="mt-2 text-[11px] text-[#e11d48]">
              No GitHub token connected. Open dashboard Settings → GitHub first.
            </p>
          ) : null}

          {phase === 'submitting' ? (
            <p className="mt-2 text-[11px] text-accent">Submitting review…</p>
          ) : null}

          {submitError ? (
            <p className="mt-2 text-[11px] text-[#e11d48]">
              {submitError}
              {submitErrorCode === 'WRITE_OUTCOME_UNKNOWN'
                ? ' Check GitHub before retrying.'
                : null}
            </p>
          ) : null}

          <div className="mt-2 flex flex-wrap gap-1">
            {phase === 'confirming' ? (
              <button
                type="button"
                disabled={!preview || githubConnected === false || draft.staleNavigation}
                onClick={() => {
                  if (preview) {
                    void handleSubmit(preview);
                  }
                }}
                className="rounded-md bg-accent-soft px-2 py-1 text-[11px] font-semibold text-accent disabled:opacity-40"
              >
                {reviewEventCtaLabel(draft.event)}
              </button>
            ) : null}
            {phase === 'uncertain' || phase === 'error' ? (
              <button
                type="button"
                onClick={() => void handleCopyPayload()}
                className="rounded-md px-2 py-1 text-[11px] font-medium text-secondary hover:bg-hover hover:text-primary"
              >
                {copied ? 'Copied' : 'Copy review'}
              </button>
            ) : null}
            <button
              type="button"
              disabled={phase === 'submitting'}
              onClick={() => {
                if (phase === 'uncertain') {
                  // Keep draft + snapshot; just return to editing carefully
                  setPhase('editing');
                  return;
                }
                resetSubmissionUi();
              }}
              className="rounded-md px-2 py-1 text-[11px] font-medium text-secondary hover:bg-hover hover:text-primary disabled:opacity-40"
            >
              Back
            </button>
          </div>
        </div>
      </div>
    );
  }

  // editing phase
  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-border bg-surface/80 px-2.5 py-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
          Review Draft · {active.length}
        </p>
        <p className="mt-1 truncate text-[11px] font-semibold text-primary">
          {draft.destination.owner}/{draft.destination.repository}#
          {draft.destination.pullRequestNumber}
        </p>
        {draft.staleNavigation ? (
          <p className="mt-1 text-[11px] text-[#e11d48]">
            Draft is bound to PR #{draft.destination.pullRequestNumber}. Current page is a different
            PR — submission disabled.
          </p>
        ) : null}
      </div>

      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
          Review event
        </p>
        <div className="mt-1 flex flex-wrap gap-1">
          {GITHUB_REVIEW_EVENTS.map((event) => (
            <button
              key={event}
              type="button"
              onClick={() => setEvent(event as GitHubReviewEvent)}
              className={cn(
                'rounded-md px-2 py-1 text-[10px] font-semibold',
                draft.event === event
                  ? 'bg-accent-soft text-accent'
                  : 'text-secondary hover:bg-hover hover:text-primary',
              )}
            >
              {event}
            </button>
          ))}
        </div>
        <p className="mt-1 text-[10px] text-muted">Default is COMMENT. AI never picks this.</p>
      </div>

      <div>
        <label className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
          Overall review body
        </label>
        <textarea
          value={draft.body}
          onChange={(event) => setOverallBody(event.target.value)}
          rows={4}
          className="mt-1 w-full resize-y rounded-md border border-border bg-elevated px-2 py-1.5 text-[11px] leading-4 text-primary outline-none focus:border-accent"
        />
      </div>

      <div className="space-y-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
          Comments ({active.length})
        </p>
        {active.length === 0 ? (
          <p className="text-[11px] text-secondary">
            No findings added yet. Use Add to Review on the report.
          </p>
        ) : (
          active.map((comment) => (
            <div
              key={comment.id}
              className="rounded-lg border border-border bg-surface px-2.5 py-2"
            >
              <p className="text-[10px] text-muted">
                {comment.severity ? `${comment.severity.toUpperCase()} · ` : ''}
                {comment.filePath ?? 'PR-level note'}
                {comment.positionStatus !== 'valid' ? ' · fallback' : ''}
              </p>
              {comment.findingTitle ? (
                <p className="mt-0.5 text-[11px] font-semibold text-primary">
                  {comment.findingTitle}
                </p>
              ) : null}
              <textarea
                value={comment.body}
                onChange={(event) => setCommentBody(comment.id, event.target.value)}
                rows={3}
                className="mt-1.5 w-full resize-y rounded-md border border-border bg-elevated px-2 py-1.5 text-[11px] leading-4 text-primary outline-none focus:border-accent"
              />
              <button
                type="button"
                onClick={() => removeComment(comment.id)}
                className="mt-1 rounded-md px-2 py-1 text-[11px] font-medium text-secondary hover:bg-hover hover:text-primary"
              >
                Remove
              </button>
            </div>
          ))
        )}
      </div>

      {removed.length > 0 ? (
        <div className="space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
            Removed ({removed.length})
          </p>
          {removed.map((comment) => (
            <div
              key={comment.id}
              className="flex items-center justify-between gap-2 rounded-md border border-border px-2 py-1.5 opacity-70"
            >
              <p className="truncate text-[11px] text-secondary">
                {comment.findingTitle ?? comment.body.slice(0, 48)}
              </p>
              <button
                type="button"
                onClick={() => restoreComment(comment.id)}
                className="shrink-0 rounded-md px-2 py-1 text-[11px] font-medium text-accent hover:bg-accent-soft"
              >
                Restore
              </button>
            </div>
          ))}
        </div>
      ) : null}

      {localError ? <p className="text-[11px] text-[#e11d48]">{localError}</p> : null}

      <div className="flex flex-wrap gap-1">
        <button
          type="button"
          onClick={() => {
            void handlePreview();
          }}
          className="rounded-md bg-accent-soft px-2 py-1 text-[11px] font-semibold text-accent"
        >
          Preview Review
        </button>
        <button
          type="button"
          onClick={() => {
            setPhase('report');
            onBackToReport();
          }}
          className="rounded-md px-2 py-1 text-[11px] font-medium text-secondary hover:bg-hover hover:text-primary"
        >
          Back
        </button>
        <button
          type="button"
          onClick={() => void handleCopyPayload()}
          className="rounded-md px-2 py-1 text-[11px] font-medium text-secondary hover:bg-hover hover:text-primary"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

/** Compact chip to open the draft from the report. */
export function ReviewDraftChip({ count, onOpen }: { count: number; onOpen: () => void }) {
  if (count <= 0) {
    return null;
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      className="rounded-md bg-accent-soft px-2 py-1 text-[10px] font-semibold text-accent"
    >
      Review Draft · {count}
    </button>
  );
}

export function findingAlreadyInDraft(
  finding: PRReviewFinding,
  draftFindingIds: Set<string>,
): boolean {
  return draftFindingIds.has(finding.id);
}
