import type { PrReviewReportDetail } from '@project-x/types';
import { useState } from 'react';

import { fetchLatestSavedPrReview, PrReviewHistoryError } from '../../api/pr-review-history';

type SavedPrReviewButtonProps = {
  owner: string;
  repository: string;
  pullRequestNumber: number;
  onOpen: (report: PrReviewReportDetail) => void;
};

/**
 * Opens the latest saved review of this PR. Fetches the stored snapshot only — never starts a
 * review, never charges usage, never writes to GitHub.
 */
export function SavedPrReviewButton({
  owner,
  repository,
  pullRequestNumber,
  onOpen,
}: SavedPrReviewButtonProps) {
  const [state, setState] = useState<
    { kind: 'idle' } | { kind: 'loading' } | { kind: 'empty' } | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  async function open() {
    setState({ kind: 'loading' });
    try {
      const report = await fetchLatestSavedPrReview({ owner, repository, pullRequestNumber });
      if (!report) {
        setState({ kind: 'empty' });
        return;
      }
      setState({ kind: 'idle' });
      onOpen(report);
    } catch (error) {
      setState({
        kind: 'error',
        message:
          error instanceof PrReviewHistoryError
            ? error.message
            : 'Saved reviews are unavailable right now. Try again.',
      });
    }
  }

  return (
    <div className="px-1 py-1">
      <button
        type="button"
        onClick={() => void open()}
        disabled={state.kind === 'loading'}
        data-testid="saved-pr-review-button"
        className="w-full rounded-lg bg-icon px-2.5 py-1.5 text-left text-[12px] font-semibold text-primary hover:bg-hover disabled:opacity-60"
      >
        {state.kind === 'loading' ? 'Loading saved review…' : 'Last saved review'}
      </button>
      {state.kind === 'empty' ? (
        <p className="px-2.5 pt-1 text-[10.5px] text-muted" role="status">
          No saved review for this PR yet.
        </p>
      ) : null}
      {state.kind === 'error' ? (
        <p className="px-2.5 pt-1 text-[10.5px] text-amber" role="alert">
          {state.message}
        </p>
      ) : null}
    </div>
  );
}
