import { forwardRef, useEffect, useState } from 'react';
import { motion } from 'framer-motion';

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
      <motion.div
        ref={ref}
        role="note"
        initial={{ opacity: 0, y: 4 }}
        animate={{ opacity: 1, y: 0 }}
        className={cn(
          'pointer-events-auto mb-1.5 max-w-[300px] rounded-2xl border border-border px-3 py-2.5 text-primary shadow-menu',
          'px-panel-wash backdrop-blur-xl',
          className,
        )}
      >
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-[12.5px] font-semibold tracking-[-0.01em] text-primary">{title}</p>
            <p className="mt-1 text-[11.5px] leading-4 text-secondary">{body}</p>
          </div>
          <button
            type="button"
            className="shrink-0 rounded-lg px-1.5 py-0.5 text-[10px] font-medium text-muted transition-colors hover:bg-hover hover:text-primary"
            onClick={() => {
              setHidden(true);
              void dismissHint(hintId);
            }}
          >
            Dismiss
          </button>
        </div>
      </motion.div>
    );
  },
);

ContextualHint.displayName = 'ContextualHint';
