'use client';

import { type ReactNode, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

type DialogProps = {
  open: boolean;
  onClose: () => void;
  /** Accessible title (rendered in the header). */
  title: ReactNode;
  /** Extra header content under the title (badges, counts). */
  subtitle?: ReactNode;
  children: ReactNode;
  /** Optional sticky footer. */
  footer?: ReactNode;
  closeLabel?: string;
  className?: string;
  /**
   * Element to focus when the dialog closes. Defaults to whatever was focused when it opened
   * (unreliable when the opener was clicked: Safari does not focus clicked buttons).
   */
  returnFocusTo?: HTMLElement | null;
  /** Return focus without scrolling (the caller animates the scroll itself). */
  returnFocusPreventScroll?: boolean;
};

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

/**
 * Modal dialog in the dashboard's visual language (same backdrop and entrance as the API
 * health dialog). Rendered in a portal so transformed / animated ancestors cannot clip it.
 * Escape, the close button and the backdrop close it; focus moves into the dialog, stays
 * there (Tab wraps) and returns to the element that opened it. The header stays visible while
 * the body scrolls.
 */
export function Dialog({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  closeLabel = 'Close',
  className,
  returnFocusTo,
  returnFocusPreventScroll = false,
}: DialogProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const returnFocusRef = useRef(returnFocusTo);
  returnFocusRef.current = returnFocusTo;
  const preventScrollRef = useRef(returnFocusPreventScroll);
  preventScrollRef.current = returnFocusPreventScroll;

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) return;
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      const target = returnFocusRef.current ?? previouslyFocused;
      if (target?.isConnected) {
        target.focus(preventScrollRef.current ? { preventScroll: true } : undefined);
      }
    };
  }, [open]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6"
      role="presentation"
    >
      <button
        type="button"
        tabIndex={-1}
        aria-label={closeLabel}
        className="fixed inset-0 bg-black/45 backdrop-blur-[6px] health-backdrop-in"
        onClick={onClose}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={[
          'relative z-10 flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-[1.5rem] border border-line bg-panel shadow-panel health-panel-in',
          className,
        ]
          .filter(Boolean)
          .join(' ')}
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-line px-5 py-4 sm:px-6">
          <div className="min-w-0 flex-1">
            <h2
              id={titleId}
              className="truncate font-display text-lg font-semibold tracking-tight text-ink"
            >
              {title}
            </h2>
            {subtitle ? <div className="mt-1.5">{subtitle}</div> : null}
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label={closeLabel}
            className="shrink-0 rounded-lg border border-line bg-panel px-2.5 py-1 text-sm text-muted-foreground transition hover:bg-mist hover:text-ink"
          >
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6">{children}</div>
        {footer ? (
          <div className="shrink-0 border-t border-line px-5 py-3 sm:px-6">{footer}</div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
