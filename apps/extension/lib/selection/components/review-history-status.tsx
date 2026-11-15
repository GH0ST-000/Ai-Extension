import { useEffect, useState } from 'react';

import { fetchReviewHistoryStatus } from '../../api/pr-review-history';

/** Delay before the single re-check (the snapshot is written before the stream ends). */
export const REVIEW_HISTORY_RECHECK_MS = 1_500;

type State = 'checking' | 'saved' | 'not_saved' | 'unknown';

/**
 * Status of the finished review in Review history. Says "saved" only when the server
 * confirmed the stored snapshot from the database; a missing snapshot is reported as such
 * (the review itself is complete either way). Never shows server error text.
 */
export function ReviewHistoryStatus({ operationId }: { operationId: string }) {
  const [state, setState] = useState<State>('checking');

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState('checking');
    const check = async (attempt: number) => {
      try {
        const result = await fetchReviewHistoryStatus(operationId);
        if (cancelled) return;
        if (result.status === 'not_saved' && attempt === 0) {
          timer = setTimeout(() => void check(1), REVIEW_HISTORY_RECHECK_MS);
          return;
        }
        setState(result.status);
      } catch {
        if (!cancelled) setState('unknown');
      }
    };
    void check(0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [operationId]);

  const text: Record<State, string> = {
    checking: 'Checking review history…',
    saved: 'Saved to Review history.',
    not_saved: 'Not saved to Review history. The review above is complete.',
    unknown: "Couldn't confirm whether this review was saved to Review history.",
  };
  return (
    <p
      role="status"
      data-testid="review-history-status"
      data-state={state}
      className={`px-2.5 pt-1 text-[10.5px] ${state === 'saved' ? 'text-muted' : state === 'checking' ? 'text-muted' : 'text-amber'}`}
    >
      {text[state]}
    </p>
  );
}
