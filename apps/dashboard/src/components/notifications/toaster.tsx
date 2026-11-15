'use client';

import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  notificationAriaLive,
  type NotificationKind,
  type NotificationRecord,
  type NotificationStore,
} from '@project-x/shared';

import { notificationStore } from '../../lib/notify';

const EMPTY: readonly NotificationRecord[] = [];

/** Which mounted <Toaster> owns rendering. A second instance renders nothing. */
let activeOwner: symbol | null = null;

/** Test hook: forget the active owner (each test mounts a fresh tree). */
export function __resetToasterOwnerForTests(): void {
  activeOwner = null;
}

const KIND_LABEL: Record<NotificationKind, string> = {
  success: 'Success',
  error: 'Error',
  warning: 'Warning',
  info: 'Info',
  loading: 'In progress',
};

const ICON_TONE: Record<NotificationKind, string> = {
  success: 'text-accent',
  error: 'text-red-600 dark:text-red-400',
  warning: 'text-amber-600 dark:text-amber-400',
  info: 'text-sky-600 dark:text-sky-400',
  loading: 'text-muted-foreground',
};

function KindIcon({ kind }: { kind: NotificationKind }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };
  switch (kind) {
    case 'success':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6.25" />
          <path d="m5.4 8.2 1.8 1.8 3.4-3.6" />
        </svg>
      );
    case 'error':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6.25" />
          <path d="m6 6 4 4M10 6l-4 4" />
        </svg>
      );
    case 'warning':
      return (
        <svg {...common}>
          <path d="M8 2.2 14.2 13H1.8L8 2.2Z" />
          <path d="M8 6.6v2.9M8 11.3v.01" />
        </svg>
      );
    case 'info':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6.25" />
          <path d="M8 7.3v3.6M8 5.1v.01" />
        </svg>
      );
    default:
      return (
        <svg {...common} className="animate-spin motion-reduce:animate-none">
          <path d="M14.25 8A6.25 6.25 0 1 1 8 1.75" />
        </svg>
      );
  }
}

/** Text for the screen-reader live regions: title + description. */
function spoken(n: NotificationRecord): string {
  return n.description ? `${n.title}. ${n.description}` : n.title;
}

/**
 * Global notification renderer for Project X Studio. Mount exactly once (root layout).
 *
 * - Top-right on desktop, full-width at the top on small screens; never blocks the page
 *   (the stack is pointer-events-none, only the toasts themselves receive clicks).
 * - Screen readers: two persistent live regions (polite / assertive) announce new
 *   notifications and outcome changes (loading → success / error) once.
 * - Keyboard: F8 moves focus to the newest notification, Escape dismisses the focused one;
 *   hover or focus pauses auto-dismiss.
 */
export function Toaster({ store = notificationStore }: { store?: NotificationStore }) {
  const [owner] = useState(() => Symbol('toaster'));
  const [isOwner, setIsOwner] = useState(false);

  useEffect(() => {
    if (activeOwner === null) {
      activeOwner = owner;
      setIsOwner(true);
    } else if (activeOwner !== owner && process.env.NODE_ENV !== 'production') {
      console.warn('[notifications] <Toaster> is already mounted; this instance renders nothing.');
    }
    return () => {
      if (activeOwner === owner) activeOwner = null;
    };
  }, [owner]);

  const items = useSyncExternalStore(store.subscribe, store.getSnapshot, () => EMPTY);

  const [polite, setPolite] = useState('');
  const [assertive, setAssertive] = useState('');
  const announced = useRef(new Map<string, string>());
  useEffect(() => {
    const seen = new Set<string>();
    for (const n of items) {
      seen.add(n.id);
      if (!n.open) continue;
      const signature = `${n.kind}|${n.title}|${n.description ?? ''}|${n.count}`;
      if (announced.current.get(n.id) === signature) continue;
      announced.current.set(n.id, signature);
      if (notificationAriaLive(n.kind) === 'assertive') setAssertive(spoken(n));
      else setPolite(spoken(n));
    }
    for (const id of [...announced.current.keys()]) {
      if (!seen.has(id)) announced.current.delete(id);
    }
  }, [items]);

  const listRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    if (!isOwner) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'F8') return;
      const toasts = listRef.current?.querySelectorAll<HTMLElement>('[data-toast]');
      const newest = toasts?.[toasts.length - 1];
      if (newest) {
        event.preventDefault();
        newest.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOwner]);

  const pause = useCallback(() => store.pause(), [store]);
  const resume = useCallback(() => store.resume(), [store]);

  if (!isOwner) return null;

  return (
    <>
      <div
        className="sr-only"
        aria-live="polite"
        aria-atomic="true"
        data-testid="toaster-live-polite"
      >
        {polite}
      </div>
      <div
        className="sr-only"
        aria-live="assertive"
        aria-atomic="true"
        data-testid="toaster-live-assertive"
      >
        {assertive}
      </div>
      <section
        aria-label="Notifications (F8)"
        className="pointer-events-none fixed inset-x-3 top-3 z-[70] flex justify-center sm:inset-x-auto sm:right-5 sm:top-5 sm:justify-end"
      >
        <ol
          ref={listRef}
          className="flex w-full max-w-[22rem] flex-col gap-2"
          onMouseEnter={pause}
          onMouseLeave={resume}
          onFocus={pause}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) resume();
          }}
        >
          {items.map((n) => (
            <ToastItem key={n.id} notification={n} onDismiss={() => store.dismiss(n.id)} />
          ))}
        </ol>
      </section>
    </>
  );
}

function ToastItem({
  notification: n,
  onDismiss,
}: {
  notification: NotificationRecord;
  onDismiss: () => void;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLLIElement>) => {
    if (event.key === 'Escape' && n.dismissible) {
      event.stopPropagation();
      onDismiss();
    }
  };
  return (
    <li
      data-toast
      data-kind={n.kind}
      data-state={n.open ? 'open' : 'closed'}
      tabIndex={-1}
      aria-label={`${KIND_LABEL[n.kind]}: ${n.title}`}
      onKeyDown={onKeyDown}
      className={[
        'toast pointer-events-auto flex items-start gap-3 rounded-xl border border-line bg-panel/95 px-3.5 py-3',
        'text-ink shadow-panel backdrop-blur supports-[backdrop-filter]:bg-panel/85',
        'outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
      ].join(' ')}
    >
      <span className={`mt-0.5 shrink-0 ${ICON_TONE[n.kind]}`}>
        <KindIcon kind={n.kind} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-sm font-semibold leading-5">
          <span className="min-w-0 break-words">{n.title}</span>
          {n.count > 1 ? (
            <span
              className="shrink-0 rounded-md bg-mist px-1.5 text-[10px] font-semibold text-muted-foreground"
              aria-label={`${n.count} times`}
            >
              ×{n.count}
            </span>
          ) : null}
        </p>
        {n.description ? (
          <p className="mt-0.5 break-words text-xs leading-5 text-muted-foreground">
            {n.description}
          </p>
        ) : null}
      </div>
      {n.dismissible ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss notification"
          className="-mr-1 -mt-0.5 shrink-0 rounded-md p-1 text-muted-foreground transition hover:bg-mist hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden fill="none">
            <path
              d="m3.5 3.5 7 7m0-7-7 7"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
            />
          </svg>
        </button>
      ) : null}
    </li>
  );
}
