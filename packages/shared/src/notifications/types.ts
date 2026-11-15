/**
 * Project X notification contracts. Framework-independent: the store and notifier in this
 * folder hold state and timing; each app (dashboard, extension) renders it its own way.
 */

export const NOTIFICATION_KINDS = ['success', 'error', 'warning', 'info', 'loading'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** Options accepted when showing or updating a notification. */
export interface NotificationOptions {
  /**
   * Stable id. Showing with an id that is already visible updates that notification in place
   * (e.g. a loading toast that becomes a success toast).
   */
  id?: string;
  description?: string;
  /** Auto-dismiss after this many ms; `null` = stays until dismissed. Default depends on kind. */
  duration?: number | null;
  /**
   * Notifications with the same key are not shown twice: the visible one is refreshed and its
   * `count` increases. Default: kind + title + description. `null` disables de-duplication.
   */
  dedupeKey?: string | null;
  /** Whether the user can close it (default true; loading notifications default to false). */
  dismissible?: boolean;
}

export interface NotificationUpdate {
  kind?: NotificationKind;
  title?: string;
  /** `null` removes the description. */
  description?: string | null;
  duration?: number | null;
  dismissible?: boolean;
}

/** One notification as renderers see it (immutable snapshot). */
export interface NotificationRecord {
  id: string;
  kind: NotificationKind;
  title: string;
  description?: string;
  /** null = no auto-dismiss. */
  duration: number | null;
  dismissible: boolean;
  /** false while playing its exit animation (it is removed afterwards). */
  open: boolean;
  /** How many times an identical notification was raised while this one was visible. */
  count: number;
  dedupeKey: string | null;
  createdAt: number;
  updatedAt: number;
}

export type NotificationListener = () => void;

/** Injectable time source (tests use a fake one). */
export interface NotificationScheduler {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export interface NotificationStoreOptions {
  /** Most notifications visible at once; the oldest non-loading one is closed first. */
  maxVisible?: number;
  /** Per-kind default auto-dismiss in ms (`null` = sticky). */
  durations?: Partial<Record<NotificationKind, number | null>>;
  /** Keep a dismissed notification (open: false) this long so renderers can animate out. */
  exitDurationMs?: number;
  scheduler?: NotificationScheduler;
}

export interface NotificationStore {
  /** Show (or, for a known id / duplicate, refresh) a notification; returns its id. */
  show(kind: NotificationKind, title: string, options?: NotificationOptions): string;
  /** Change a visible notification; returns false when it no longer exists. */
  update(id: string, patch: NotificationUpdate): boolean;
  /** Dismiss one notification, or all when no id is given. */
  dismiss(id?: string): void;
  /** Stop auto-dismiss timers (e.g. while hovered or focused), one or all. */
  pause(id?: string): void;
  resume(id?: string): void;
  get(id: string): NotificationRecord | undefined;
  /** Immutable list, oldest first; a new array after every change. */
  getSnapshot(): readonly NotificationRecord[];
  subscribe(listener: NotificationListener): () => void;
  /** Remove everything and cancel all timers (tests, sign-out). */
  reset(): void;
}

/** Message for one outcome of an async operation. */
export type NotificationMessage = string | ({ title: string } & NotificationOptions);

export interface NotifyPromiseMessages<T> {
  loading: NotificationMessage;
  success: NotificationMessage | ((result: T) => NotificationMessage);
  /**
   * Error message. Return `null` when the caller shows the error elsewhere (inline form
   * error); the loading notification is then simply dismissed.
   */
  error: NotificationMessage | null | ((error: unknown) => NotificationMessage | null);
}

/** Public API apps expose as `notify`. */
export interface Notifier {
  success(title: string, description?: string | NotificationOptions): string;
  error(title: string, description?: string | NotificationOptions): string;
  warning(title: string, description?: string | NotificationOptions): string;
  info(title: string, description?: string | NotificationOptions): string;
  loading(title: string, description?: string | NotificationOptions): string;
  update(id: string, patch: NotificationUpdate): boolean;
  dismiss(id?: string): void;
  /**
   * loading → success / error for an async operation. Success is shown only after the
   * operation resolved. Resolves / rejects exactly like the operation itself.
   */
  promise<T>(
    operation: Promise<T> | (() => Promise<T>),
    messages: NotifyPromiseMessages<T>,
  ): Promise<T>;
}
