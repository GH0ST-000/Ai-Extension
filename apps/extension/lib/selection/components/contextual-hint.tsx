import { forwardRef, useEffect, useState } from 'react';

import { cn } from '~/lib/utils/cn';
import { dismissHint } from '~/lib/onboarding/onboarding-api';

type ContextualHintProps = {
  hintId: string;
  title: string;
  body: string;
  dismissedIds?: string[];
  className?: string;
};

/**
 * Small dismissible first-use hint. Dismissal is persisted server-side when signed in.
 */
export const ContextualHint = forwardRef<HTMLDivElement, ContextualHintProps>(
  function ContextualHint({ hintId, title, body, dismissedIds = [], className }, ref) {
    const [hidden, setHidden] = useState(dismissedIds.includes(hintId));

    useEffect(() => {
      if (dismissedIds.includes(hintId)) {
        setHidden(true);
      }
    }, [dismissedIds, hintId]);

    if (hidden) {
      return null;
    }

    return (
      <div
        ref={ref}
        role="note"
        className={cn(
          'pointer-events-auto mb-1 max-w-[280px] rounded-[10px] border border-border bg-elevated px-2.5 py-2 text-primary shadow-menu',
          className,
        )}
      >
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-[11px] font-semibold text-primary">{title}</p>
            <p className="mt-0.5 text-[11px] leading-4 text-secondary">{body}</p>
          </div>
          <button
            type="button"
            className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] text-muted hover:bg-hover hover:text-primary"
            onClick={() => {
              setHidden(true);
              void dismissHint(hintId);
            }}
          >
            Dismiss
          </button>
        </div>
      </div>
    );
  },
);

ContextualHint.displayName = 'ContextualHint';
