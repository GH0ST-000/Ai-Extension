import type {
  NotificationKind,
  NotificationListener,
  NotificationOptions,
  NotificationRecord,
  NotificationScheduler,
  NotificationStore,
  NotificationStoreOptions,
  NotificationUpdate,
} from './types';

/** Default auto-dismiss per kind (ms). Errors stay longer; loading stays until resolved. */
export const DEFAULT_NOTIFICATION_DURATIONS: Readonly<Record<NotificationKind, number | null>> = {
  success: 4_000,
  info: 5_000,
  warning: 6_000,
  error: 8_000,
  loading: null,
};

export const DEFAULT_MAX_VISIBLE_NOTIFICATIONS = 5;

const MAX_TITLE_CHARS = 120;
const MAX_DESCRIPTION_CHARS = 300;

const systemScheduler: NotificationScheduler = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

type Entry = {
  record: NotificationRecord;
  /** Auto-dismiss timer while running. */
  timer?: unknown;
  /** Exit-animation removal timer after dismissal. */
  exitTimer?: unknown;
  /** Time left before auto-dismiss (tracked across pauses). */
  remaining: number | null;
  startedAt: number;
  paused: boolean;
};

function clip(text: string, max: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

/**
 * Framework-independent notification state. Compatible with React's `useSyncExternalStore`
 * (`subscribe` + `getSnapshot`), and usable from plain DOM code.
 */
export function createNotificationStore(options: NotificationStoreOptions = {}): NotificationStore {
  const scheduler = options.scheduler ?? systemScheduler;
  const durations = { ...DEFAULT_NOTIFICATION_DURATIONS, ...options.durations };
  const maxVisible = Math.max(1, options.maxVisible ?? DEFAULT_MAX_VISIBLE_NOTIFICATIONS);
  const exitMs = Math.max(0, options.exitDurationMs ?? 0);

  const entries = new Map<string, Entry>();
  const listeners = new Set<NotificationListener>();
  let snapshot: readonly NotificationRecord[] = [];
  let sequence = 0;

  const emit = () => {
    snapshot = [...entries.values()].map((e) => e.record);
    for (const listener of [...listeners]) listener();
  };

  const nextId = () => {
    sequence += 1;
    return `ntf_${sequence.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  };

  const stopTimer = (entry: Entry) => {
    if (entry.timer !== undefined) {
      scheduler.clearTimeout(entry.timer);
      entry.timer = undefined;
    }
  };

  const startTimer = (entry: Entry) => {
    stopTimer(entry);
    if (entry.remaining === null || entry.paused || !entry.record.open) return;
    entry.startedAt = scheduler.now();
    const id = entry.record.id;
    entry.timer = scheduler.setTimeout(() => dismiss(id), Math.max(0, entry.remaining));
  };

  /** Restart the full duration (after show / update / duplicate). */
  const restartTimer = (entry: Entry) => {
    entry.remaining = entry.record.duration;
    startTimer(entry);
  };

  const remove = (id: string) => {
    const entry = entries.get(id);
    if (!entry) return;
    stopTimer(entry);
    if (entry.exitTimer !== undefined) scheduler.clearTimeout(entry.exitTimer);
    entries.delete(id);
  };

  function dismiss(id?: string): void {
    const ids = id === undefined ? [...entries.keys()] : [id];
    let changed = false;
    for (const target of ids) {
      const entry = entries.get(target);
      if (!entry || !entry.record.open) continue;
      stopTimer(entry);
      changed = true;
      if (exitMs === 0) {
        remove(target);
        continue;
      }
      entry.record = { ...entry.record, open: false, updatedAt: scheduler.now() };
      entry.exitTimer = scheduler.setTimeout(() => {
        remove(target);
        emit();
      }, exitMs);
    }
    if (changed) emit();
  }

  const enforceLimit = () => {
    const open = [...entries.values()].filter((e) => e.record.open);
    let excess = open.length - maxVisible;
    // Oldest first; loading notifications track running work, so they are closed last.
    const victims = [
      ...open.filter((e) => e.record.kind !== 'loading'),
      ...open.filter((e) => e.record.kind === 'loading'),
    ];
    for (const entry of victims) {
      if (excess <= 0) break;
      dismiss(entry.record.id);
      excess -= 1;
    }
  };

  const durationFor = (kind: NotificationKind, requested: number | null | undefined) =>
    requested === undefined ? durations[kind] : requested === null ? null : Math.max(0, requested);

  function show(kind: NotificationKind, title: string, opts: NotificationOptions = {}): string {
    const now = scheduler.now();
    const cleanTitle = clip(title, MAX_TITLE_CHARS) || 'Notification';
    const description = opts.description
      ? clip(opts.description, MAX_DESCRIPTION_CHARS)
      : undefined;
    const dedupeKey =
      opts.dedupeKey === null
        ? null
        : (opts.dedupeKey ?? `${kind}|${cleanTitle}|${description ?? ''}`);

    // Known id → update in place.
    if (opts.id && entries.get(opts.id)?.record.open) {
      update(opts.id, {
        kind,
        title: cleanTitle,
        description: description ?? null,
        ...(opts.duration !== undefined ? { duration: opts.duration } : {}),
        ...(opts.dismissible !== undefined ? { dismissible: opts.dismissible } : {}),
      });
      return opts.id;
    }

    // Duplicate of a visible notification → refresh it instead of stacking a copy.
    if (dedupeKey !== null) {
      for (const entry of entries.values()) {
        if (entry.record.open && entry.record.dedupeKey === dedupeKey) {
          entry.record = { ...entry.record, count: entry.record.count + 1, updatedAt: now };
          restartTimer(entry);
          emit();
          return entry.record.id;
        }
      }
    }

    // An id whose notification is still animating out is replaced by a fresh one.
    if (opts.id) remove(opts.id);
    const id = opts.id ?? nextId();
    const record: NotificationRecord = {
      id,
      kind,
      title: cleanTitle,
      ...(description ? { description } : {}),
      duration: durationFor(kind, opts.duration),
      dismissible: opts.dismissible ?? kind !== 'loading',
      open: true,
      count: 1,
      dedupeKey,
      createdAt: now,
      updatedAt: now,
    };
    const entry: Entry = { record, remaining: record.duration, startedAt: now, paused: false };
    entries.set(id, entry);
    startTimer(entry);
    enforceLimit();
    emit();
    return id;
  }

  function update(id: string, patch: NotificationUpdate): boolean {
    const entry = entries.get(id);
    if (!entry || !entry.record.open) return false;
    const kind = patch.kind ?? entry.record.kind;
    const title =
      patch.title !== undefined ? clip(patch.title, MAX_TITLE_CHARS) : entry.record.title;
    const description =
      patch.description === null
        ? undefined
        : patch.description !== undefined
          ? clip(patch.description, MAX_DESCRIPTION_CHARS)
          : entry.record.description;
    const kindChanged = kind !== entry.record.kind;
    const { description: _drop, ...rest } = entry.record;
    entry.record = {
      ...rest,
      kind,
      title,
      ...(description ? { description } : {}),
      duration:
        patch.duration !== undefined
          ? durationFor(kind, patch.duration)
          : kindChanged
            ? durations[kind]
            : entry.record.duration,
      dismissible:
        patch.dismissible ?? (kindChanged ? kind !== 'loading' : entry.record.dismissible),
      // A default key follows the content; a custom (or disabled) key is kept as given.
      dedupeKey:
        entry.record.dedupeKey ===
        `${entry.record.kind}|${entry.record.title}|${entry.record.description ?? ''}`
          ? `${kind}|${title}|${description ?? ''}`
          : entry.record.dedupeKey,
      updatedAt: scheduler.now(),
    };
    restartTimer(entry);
    emit();
    return true;
  }

  function setPaused(paused: boolean, id?: string) {
    const targets = id === undefined ? [...entries.values()] : [entries.get(id)].filter(Boolean);
    for (const entry of targets as Entry[]) {
      if (entry.paused === paused) continue;
      if (paused) {
        if (entry.timer !== undefined && entry.remaining !== null) {
          entry.remaining = Math.max(0, entry.remaining - (scheduler.now() - entry.startedAt));
        }
        stopTimer(entry);
        entry.paused = true;
      } else {
        entry.paused = false;
        startTimer(entry);
      }
    }
  }

  return {
    show,
    update,
    dismiss,
    pause: (id) => setPaused(true, id),
    resume: (id) => setPaused(false, id),
    get: (id) => entries.get(id)?.record,
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reset() {
      for (const id of [...entries.keys()]) remove(id);
      emit();
    },
  };
}
