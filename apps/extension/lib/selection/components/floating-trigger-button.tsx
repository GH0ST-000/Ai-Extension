import { forwardRef } from 'react';
import { motion } from 'framer-motion';

import { cn } from '~/lib/utils/cn';

import { BrandMark } from './brand-mark';

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
        title="Ask AI — Project X"
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
        initial={{ opacity: 0, scale: 0.88, y: 6 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.94, y: 3 }}
        transition={{ type: 'spring', stiffness: 520, damping: 32, mass: 0.5 }}
        whileHover={{ scale: 1.04, y: -1 }}
        whileTap={{ scale: 0.97 }}
        className={cn(
          'pointer-events-auto inline-flex h-9 items-center justify-center rounded-full',
          'px-panel-wash text-primary shadow-float backdrop-blur-xl',
          'border border-border',
          'outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
          compact ? 'w-9 px-0' : 'gap-2 pl-1.5 pr-3',
        )}
      >
        <BrandMark className={cn('h-6 w-6 rounded-[8px]', compact && 'h-5 w-5 rounded-[7px]')} />
        {!compact ? (
          <span className="pr-0.5 text-[12.5px] font-semibold leading-none tracking-[-0.01em]">
            Ask AI
          </span>
        ) : null}
      </motion.button>
    );
  },
);
