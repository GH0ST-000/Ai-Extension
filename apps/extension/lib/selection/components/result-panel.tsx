import { forwardRef, useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import type { AIAction } from '@project-x/types';

import { cn } from '~/lib/utils/cn';

import { getActionLabel } from '../constants';

type ResultPanelProps = {
  action: AIAction;
  content: string;
  streaming?: boolean;
  onCopy: () => Promise<boolean>;
  onRetry: () => void;
  onBack: () => void;
  onClose: () => void;
};

export const ResultPanel = forwardRef<HTMLDivElement, ResultPanelProps>(function ResultPanel(
  { action, content, streaming = false, onCopy, onRetry, onBack, onClose },
  ref,
) {
  const [copied, setCopied] = useState(false);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    if (!streaming || !stickToBottomRef.current) {
      return;
    }
    const node = scrollerRef.current;
    if (!node) {
      return;
    }
    node.scrollTop = node.scrollHeight;
  }, [content, streaming]);

  return (
    <motion.div
      ref={ref}
      role="region"
      aria-label={`${getActionLabel(action)} result`}
      initial={{ opacity: 0, scale: 0.98, y: 4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98, y: 2 }}
      transition={{ type: 'spring', stiffness: 480, damping: 32, mass: 0.55 }}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      className={cn(
        'pointer-events-auto flex w-[280px] max-h-[360px] flex-col overflow-hidden rounded-[12px]',
        'bg-elevated text-primary shadow-menu backdrop-blur-2xl border border-border',
      )}
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
          {getActionLabel(action)}
          {streaming ? ' · Streaming' : ''}
        </p>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md px-2 py-1 text-[11px] text-muted hover:bg-hover hover:text-primary"
        >
          Close
        </button>
      </div>

      <div
        ref={scrollerRef}
        onScroll={(event) => {
          const target = event.currentTarget;
          const distanceFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
          stickToBottomRef.current = distanceFromBottom < 48;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-2"
      >
        <p className="whitespace-pre-wrap break-words text-[12.5px] leading-5 text-primary">
          {content}
          {streaming ? <span className="ml-0.5 inline-block text-accent">▍</span> : null}
        </p>
      </div>

      <div className="flex items-center gap-1 border-t border-border px-2 py-1.5">
        <button
          type="button"
          disabled={streaming || content.trim().length === 0}
          onClick={async () => {
            const ok = await onCopy();
            if (!ok) {
              return;
            }
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          }}
          className="rounded-md px-2 py-1 text-[11px] font-medium text-secondary hover:bg-hover hover:text-primary disabled:opacity-40"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md px-2 py-1 text-[11px] font-medium text-secondary hover:bg-hover hover:text-primary"
        >
          Retry
        </button>
        <button
          type="button"
          onClick={onBack}
          className="rounded-md px-2 py-1 text-[11px] font-medium text-secondary hover:bg-hover hover:text-primary"
        >
          Back
        </button>
      </div>
    </motion.div>
  );
});
