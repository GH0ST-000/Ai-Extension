import { useEffect } from 'react';

import { useReviewMemoryModeStore } from '../../project-memory';

/**
 * Project Memory ON/OFF for the next "Review Entire PR". The value is sent explicitly with
 * the review request (`projectMemoryMode`); OFF means the server retrieves no memory at all.
 */
export function PrReviewMemoryToggle() {
  const mode = useReviewMemoryModeStore((s) => s.mode);
  const hydrated = useReviewMemoryModeStore((s) => s.hydrated);
  const setMode = useReviewMemoryModeStore((s) => s.setMode);
  const hydrate = useReviewMemoryModeStore((s) => s.hydrate);

  useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrated, hydrate]);

  const on = mode === 'on';
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg bg-icon px-2.5 py-1.5">
      <div className="min-w-0">
        <p className="text-[12px] font-semibold text-primary">Project Memory for PR review</p>
        <p className="text-[10px] leading-tight text-muted">
          {on
            ? 'Saved repository rules are applied to the next review.'
            : 'Off — the next review runs without any saved rules.'}
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label="Project Memory for PR review"
        data-testid="pr-review-memory-toggle"
        onClick={() => setMode(on ? 'off' : 'on')}
        className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
          on ? 'bg-accent text-[#042f2e]' : 'bg-hover text-secondary'
        }`}
      >
        {on ? 'On' : 'Off'}
      </button>
    </div>
  );
}
