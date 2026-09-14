import { forwardRef } from 'react';
import { motion } from 'framer-motion';

import { cn } from '~/lib/utils/cn';

import { getActionLabel } from '../constants';
import type { AIAction } from '@project-x/types';
import { BrandMark } from './brand-mark';

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
      initial={{ opacity: 0, scale: 0.96, y: 6 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98, y: 4 }}
      transition={{ type: 'spring', stiffness: 420, damping: 30 }}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      className={cn(
        'pointer-events-auto w-[300px] overflow-hidden rounded-panel p-3',
        'px-panel-wash text-primary shadow-menu backdrop-blur-2xl border border-border',
      )}
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="relative">
            <BrandMark className="h-7 w-7 rounded-[9px]" />
            <span
              aria-hidden
              className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-accent px-breathe"
            />
          </div>
          <div className="min-w-0">
            <p className="truncate text-[12px] font-semibold tracking-tight text-primary">
              {getActionLabel(action)}
            </p>
            <p className="text-[11px] text-muted">Composing a thoughtful answer…</p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg px-2 py-1 text-[11px] font-medium text-muted transition-colors hover:bg-hover hover:text-primary"
        >
          Close
        </button>
      </div>
      <div className="space-y-2 rounded-xl bg-surface/60 p-2.5 ring-1 ring-border">
        <div className="h-2.5 w-11/12 rounded-full px-shimmer motion-reduce:animate-none" />
        <div className="h-2.5 w-9/12 rounded-full px-shimmer motion-reduce:animate-none" />
        <div className="h-2.5 w-10/12 rounded-full px-shimmer motion-reduce:animate-none" />
      </div>
    </motion.div>
  );
});
