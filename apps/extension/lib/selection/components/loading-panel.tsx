import { forwardRef } from 'react';
import { motion } from 'framer-motion';

import { cn } from '~/lib/utils/cn';

import { getActionLabel } from '../constants';
import type { AIAction } from '@project-x/types';

type LoadingPanelProps = {
  action: AIAction;
  onClose: () => void;
};

export const LoadingPanel = forwardRef<HTMLDivElement, LoadingPanelProps>(function LoadingPanel(
  { action, onClose },
  ref,
) {
  return (
    <motion.div
      ref={ref}
      role="status"
      aria-live="polite"
      aria-label={`${getActionLabel(action)} loading`}
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.98 }}
      transition={{ duration: 0.16 }}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      className={cn(
        'pointer-events-auto w-[280px] overflow-hidden rounded-[12px] p-2',
        'bg-elevated text-primary shadow-menu backdrop-blur-2xl border border-border',
      )}
    >
      <div className="mb-2 flex items-center justify-between px-1">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
            {getActionLabel(action)}
          </p>
          <p className="mt-1 text-[12px] text-secondary motion-safe:animate-pulse">Thinking...</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md px-2 py-1 text-[11px] text-muted hover:bg-hover hover:text-primary"
        >
          Close
        </button>
      </div>
      <div className="space-y-2 px-1 pb-1">
        <div className="h-2.5 w-11/12 rounded bg-hover motion-reduce:animate-none motion-safe:animate-pulse" />
        <div className="h-2.5 w-9/12 rounded bg-hover motion-reduce:animate-none motion-safe:animate-pulse" />
        <div className="h-2.5 w-10/12 rounded bg-hover motion-reduce:animate-none motion-safe:animate-pulse" />
      </div>
    </motion.div>
  );
});
