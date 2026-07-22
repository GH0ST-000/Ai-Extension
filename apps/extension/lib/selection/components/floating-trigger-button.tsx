import { forwardRef } from 'react';
import { motion } from 'framer-motion';

import { cn } from '~/lib/utils/cn';

import { SparkIcon } from './icons';

type FloatingTriggerButtonProps = {
  onOpen: () => void;
  compact?: boolean;
};

export const FloatingTriggerButton = forwardRef<HTMLButtonElement, FloatingTriggerButtonProps>(
  function FloatingTriggerButton({ onOpen, compact = false }, ref) {
    return (
      <motion.button
        ref={ref}
        type="button"
        aria-label="Ask AI"
        title="Ask AI"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onOpen();
        }}
        onMouseDown={(event) => {
          // Preserve host-page selection when interacting with the trigger.
          event.preventDefault();
          event.stopPropagation();
        }}
        initial={{ opacity: 0, scale: 0.92, y: 4 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 2 }}
        transition={{ type: 'spring', stiffness: 560, damping: 34, mass: 0.45 }}
        whileHover={{ scale: 1.02 }}
        whileTap={{ scale: 0.98 }}
        className={cn(
          'pointer-events-auto inline-flex h-8 items-center justify-center rounded-full',
          'bg-elevated text-primary shadow-float backdrop-blur-xl',
          'border border-border',
          'outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
          compact ? 'w-8 px-0' : 'gap-1.5 px-2.5',
        )}
      >
        <span
          className={cn(
            'flex items-center justify-center text-accent',
            compact ? 'h-4 w-4' : 'h-4 w-4 rounded-full bg-accent-soft',
          )}
        >
          <SparkIcon className="h-2.5 w-2.5" />
        </span>
        {!compact ? (
          <span className="text-[12px] font-medium leading-none tracking-tight">Ask AI</span>
        ) : null}
      </motion.button>
    );
  },
);
