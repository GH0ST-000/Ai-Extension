import { forwardRef, useCallback } from 'react';
import { motion } from 'framer-motion';

import { cn } from '~/lib/utils/cn';

type CustomPromptPanelProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onBack: () => void;
  onClose: () => void;
};

export const CustomPromptPanel = forwardRef<HTMLDivElement, CustomPromptPanelProps>(
  function CustomPromptPanel({ value, onChange, onSubmit, onBack, onClose }, ref) {
    const canSubmit = value.trim().length > 0;

    const submit = useCallback(() => {
      if (!canSubmit) {
        return;
      }
      onSubmit();
    }, [canSubmit, onSubmit]);

    return (
      <motion.div
        ref={ref}
        role="dialog"
        aria-label="Custom prompt"
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
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
            Custom Prompt
          </p>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-[11px] text-muted hover:bg-hover hover:text-primary"
          >
            Close
          </button>
        </div>

        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault();
              submit();
            }
          }}
          placeholder="Tell Ask AI what to do with the selected text…"
          rows={4}
          className={cn(
            'w-full resize-none rounded-md border border-border bg-surface px-2.5 py-2',
            'text-[12.5px] leading-5 text-primary placeholder:text-muted',
            'outline-none focus-visible:ring-1 focus-visible:ring-accent/40',
          )}
        />

        <div className="mt-2 flex items-center justify-between px-1">
          <button
            type="button"
            onClick={onBack}
            className="rounded-md px-2 py-1 text-[11px] font-medium text-secondary hover:bg-hover hover:text-primary"
          >
            Back
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={submit}
            className={cn(
              'rounded-md px-2.5 py-1 text-[11px] font-medium',
              'bg-accent text-white disabled:opacity-40',
            )}
          >
            Run
          </button>
        </div>
      </motion.div>
    );
  },
);
