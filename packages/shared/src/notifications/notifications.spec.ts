import { describe, expect, it, vi } from 'vitest';

import {
  createNotificationStore,
  createNotifier,
  isSafeDisplayMessage,
  normalizeError,
  notificationAriaLive,
  notificationAriaRole,
  safeErrorMessage,
  type NotificationScheduler,
} from './index';

/** Deterministic clock: timers fire only when `advance` passes them. */
function fakeScheduler() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const scheduler: NotificationScheduler = {
    now: () => now,
    setTimeout: (fn, ms) => {
      seq += 1;
      timers.set(seq, { at: now + ms, fn });
      return seq;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
  };
  const advance = (ms: number) => {
    const target = now + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at;
      timers.delete(due[0]);
      due[1].fn();
    }
    now = target;
  };
  return { scheduler, advance, pending: () => timers.size };
}

function setup(options: Parameters<typeof createNotificationStore>[0] = {}) {
  const clock = fakeScheduler();
  const store = createNotificationStore({ scheduler: clock.scheduler, ...options });
  return { ...clock, store, notify: createNotifier(store) };
}

describe('notification store', () => {
  it('shows each kind with title, optional description and a unique id', () => {
    const { store, notify } = setup();
    const ids = [
      notify.success('Saved', 'Rule updated.'),
      notify.error('Failed'),
      notify.warning('Careful'),
      notify.info('FYI', { description: 'More' }),
      notify.loading('Working'),
    ];
    expect(new Set(ids).size).toBe(5);
    expect(store.getSnapshot().map((n) => [n.kind, n.title, n.description])).toEqual([
      ['success', 'Saved', 'Rule updated.'],
      ['error', 'Failed', undefined],
      ['warning', 'Careful', undefined],
      ['info', 'FYI', 'More'],
      ['loading', 'Working', undefined],
    ]);
  });

  it('auto-dismisses by kind; loading stays until resolved; manual dismissal works', () => {
    const { store, notify, advance } = setup();
    const ok = notify.success('Saved');
    const err = notify.error('Failed');
    const busy = notify.loading('Working');
    advance(4_000);
    expect(store.get(ok)).toBeUndefined();
    expect(store.get(err)).toBeDefined();
    advance(4_000);
    expect(store.get(err)).toBeUndefined();
    advance(60_000);
    expect(store.get(busy)?.open).toBe(true);
    expect(store.get(busy)?.dismissible).toBe(false);
    notify.dismiss(busy);
    expect(store.getSnapshot()).toEqual([]);
  });

  it('custom duration and sticky notifications', () => {
    const { store, notify, advance } = setup();
    const quick = notify.info('Quick', { duration: 500 });
    const sticky = notify.warning('Sticky', { duration: null });
    advance(600);
    expect(store.get(quick)).toBeUndefined();
    advance(600_000);
    expect(store.get(sticky)).toBeDefined();
  });

  it('prevents duplicates: an identical visible notification is refreshed, not stacked', () => {
    const { store, notify, advance } = setup();
    const a = notify.error('Network error', 'Try again.');
    advance(7_000);
    const b = notify.error('Network error', 'Try again.');
    expect(b).toBe(a);
    expect(store.getSnapshot()).toHaveLength(1);
    expect(store.get(a)?.count).toBe(2);
    advance(7_000); // timer restarted by the duplicate
    expect(store.get(a)).toBeDefined();
    // Different text, or de-duplication disabled → separate notifications.
    notify.error('Network error', 'Other.');
    notify.error('Network error', { description: 'Try again.', dedupeKey: null });
    expect(store.getSnapshot()).toHaveLength(3);
    // Custom keys group differently worded messages.
    const k1 = notify.info('Saving 1', { dedupeKey: 'autosave' });
    expect(notify.info('Saving 2', { dedupeKey: 'autosave' })).toBe(k1);
  });

  it('updates an existing notification in place (by id), resetting its timer', () => {
    const { store, notify, advance } = setup();
    const id = notify.loading('Uploading');
    expect(notify.update(id, { kind: 'success', title: 'Uploaded', description: '3 files' })).toBe(
      true,
    );
    expect(store.get(id)).toMatchObject({
      kind: 'success',
      title: 'Uploaded',
      description: '3 files',
      dismissible: true,
      duration: 4_000,
    });
    // Showing with the same id also updates instead of adding.
    notify.info('Still here', { id });
    expect(store.getSnapshot()).toHaveLength(1);
    expect(store.get(id)?.kind).toBe('info');
    advance(5_000);
    expect(notify.update(id, { title: 'gone' })).toBe(false);
  });

  it('pause/resume keeps the remaining time (hover / focus)', () => {
    const { store, notify, advance } = setup();
    const id = notify.success('Saved');
    advance(3_000);
    store.pause();
    advance(60_000);
    expect(store.get(id)).toBeDefined();
    store.resume();
    advance(999);
    expect(store.get(id)).toBeDefined();
    advance(2);
    expect(store.get(id)).toBeUndefined();
  });

  it('exit animation: dismissed notifications stay closed for exitDurationMs, then are removed', () => {
    const { store, notify, advance, pending } = setup({ exitDurationMs: 200 });
    const id = notify.info('Bye');
    notify.dismiss(id);
    expect(store.get(id)).toMatchObject({ open: false });
    advance(200);
    expect(store.get(id)).toBeUndefined();
    expect(pending()).toBe(0);
  });

  it('caps visible notifications, closing the oldest non-loading first', () => {
    const { store, notify } = setup({ maxVisible: 3 });
    const busy = notify.loading('Working');
    notify.info('one');
    notify.info('two');
    notify.info('three');
    expect(store.getSnapshot().map((n) => n.title)).toEqual(['Working', 'two', 'three']);
    expect(store.get(busy)).toBeDefined();
  });

  it('subscribers get a new immutable snapshot per change; unsubscribe and reset clean up', () => {
    const { store, notify, pending } = setup();
    const listener = vi.fn();
    const off = store.subscribe(listener);
    const before = store.getSnapshot();
    notify.info('x');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).not.toBe(before);
    expect(store.getSnapshot()).toBe(store.getSnapshot()); // stable between changes
    off();
    notify.info('y');
    expect(listener).toHaveBeenCalledTimes(1);
    store.reset();
    expect(store.getSnapshot()).toEqual([]);
    expect(pending()).toBe(0);
  });

  it('clips very long titles and descriptions', () => {
    const { store, notify } = setup();
    const id = notify.info('t'.repeat(500), 'd'.repeat(2_000));
    expect(store.get(id)!.title.length).toBeLessThanOrEqual(120);
    expect(store.get(id)!.description!.length).toBeLessThanOrEqual(300);
  });
});

describe('notify.promise (async lifecycle)', () => {
  it('loading → success only after the operation resolves', async () => {
    const { store, notify } = setup();
    let resolve!: (v: number) => void;
    const op = new Promise<number>((r) => (resolve = r));
    const result = notify.promise(op, {
      loading: 'Saving rule…',
      success: (n) => ({ title: 'Rule saved', description: `${n} rule` }),
      error: 'Could not save',
    });
    expect(store.getSnapshot()).toMatchObject([{ kind: 'loading', title: 'Saving rule…' }]);
    resolve(1);
    await expect(result).resolves.toBe(1);
    expect(store.getSnapshot()).toMatchObject([
      { kind: 'success', title: 'Rule saved', description: '1 rule' },
    ]);
  });

  it('loading → error, rethrowing the original error', async () => {
    const { store, notify } = setup();
    const boom = Object.assign(new Error('Rule text is required.'), { statusCode: 400 });
    await expect(
      notify.promise(() => Promise.reject(boom), {
        loading: 'Saving…',
        success: 'Saved',
        error: (e) => ({ title: 'Could not save', description: safeErrorMessage(e) }),
      }),
    ).rejects.toBe(boom);
    expect(store.getSnapshot()).toMatchObject([
      { kind: 'error', title: 'Could not save', description: 'Rule text is required.' },
    ]);
  });

  it('error: null dismisses the loading notification (error shown inline instead)', async () => {
    const { store, notify } = setup({ exitDurationMs: 0 });
    await expect(
      notify.promise(Promise.reject(new Error('x')), {
        loading: 'Saving…',
        success: 'ok',
        error: null,
      }),
    ).rejects.toThrow('x');
    expect(store.getSnapshot()).toEqual([]);
  });

  it('two concurrent operations keep separate loading notifications', async () => {
    const { store, notify } = setup();
    const a = notify.promise(Promise.resolve('a'), {
      loading: 'Saving…',
      success: 'A',
      error: 'e',
    });
    const b = notify.promise(Promise.resolve('b'), {
      loading: 'Saving…',
      success: 'B',
      error: 'e',
    });
    expect(store.getSnapshot().filter((n) => n.kind === 'loading')).toHaveLength(2);
    await Promise.all([a, b]);
    expect(
      store
        .getSnapshot()
        .map((n) => n.title)
        .sort(),
    ).toEqual(['A', 'B']);
  });

  it('the outcome is still announced if the loading toast was dismissed meanwhile', async () => {
    const { store, notify } = setup();
    let resolve!: () => void;
    const p = notify.promise(new Promise<void>((r) => (resolve = r)), {
      loading: 'Working',
      success: 'Done',
      error: 'Failed',
    });
    notify.dismiss();
    resolve();
    await p;
    expect(store.getSnapshot()).toMatchObject([{ kind: 'success', title: 'Done' }]);
  });
});

describe('safe error normalization', () => {
  const api = (statusCode: number, message: string, code?: string) =>
    Object.assign(new Error(message), { name: 'ApiError', statusCode, ...(code ? { code } : {}) });

  it('uses curated 4xx server messages and codes', () => {
    expect(
      normalizeError(api(400, 'Rule text is required.', 'PROJECT_MEMORY_VALIDATION_FAILED')),
    ).toEqual({
      category: 'validation',
      message: 'Rule text is required.',
      status: 400,
      code: 'PROJECT_MEMORY_VALIDATION_FAILED',
    });
    expect(normalizeError(api(409, 'Changed by someone else.')).category).toBe('conflict');
    expect(normalizeError(api(403, 'Ask an Owner.')).message).toBe('Ask an Owner.');
    expect(normalizeError(api(404, 'Not found.')).category).toBe('not_found');
    expect(normalizeError(api(429, 'slow down')).category).toBe('rate_limited');
  });

  it('never shows server error details, stack traces, SQL, paths or credentials', () => {
    const leaks = [
      api(500, 'Invalid `prisma.projectMemory.update()` invocation'),
      api(400, 'Error: boom\n    at Service.update (/Users/dev/app/src/x.ts:10:5)'),
      api(400, 'duplicate key: SELECT * FROM project_memories WHERE id = 1'),
      api(400, 'connect ECONNREFUSED 127.0.0.1:5432'),
      api(400, '<html><body>Bad gateway</body></html>'),
      api(400, '{"stack":"..."}'),
      api(400, 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789 rejected'),
      api(403, 'Authorization: Bearer abc.def.ghi'),
    ];
    for (const err of leaks) {
      const { message } = normalizeError(err);
      expect(message).not.toMatch(/prisma|SELECT|ECONNREFUSED|html|stack|ghp_|Bearer|Users/i);
    }
    expect(normalizeError(api(503, 'Upstream x failed')).message).toBe(
      'Something went wrong on our side. Try again in a moment.',
    );
  });

  it('401 always asks to sign in again (no server text)', () => {
    expect(normalizeError(api(401, 'jwt malformed'))).toMatchObject({
      category: 'unauthorized',
      message: 'Your session has expired. Sign in again to continue.',
    });
  });

  it('network failures, aborts, strings and unknown values', () => {
    expect(normalizeError(new TypeError('Failed to fetch')).category).toBe('network');
    expect(normalizeError(new TypeError('Load failed')).category).toBe('network');
    expect(normalizeError(Object.assign(new Error('x'), { name: 'AbortError' })).category).toBe(
      'aborted',
    );
    expect(normalizeError('weird', 'Could not save.')).toEqual({
      category: 'unknown',
      message: 'Could not save.',
    });
    expect(normalizeError(undefined).message).toBe('Something went wrong. Try again.');
    expect(normalizeError(new Error('Cannot read properties of undefined')).message).toBe(
      'Something went wrong. Try again.',
    );
  });

  it('isSafeDisplayMessage', () => {
    expect(isSafeDisplayMessage('Rule text exceeds 400 characters.')).toBe(true);
    expect(isSafeDisplayMessage('')).toBe(false);
    expect(isSafeDisplayMessage(42)).toBe(false);
    expect(isSafeDisplayMessage('x'.repeat(1_000))).toBe(false);
  });

  it('accessibility roles', () => {
    expect(notificationAriaRole('error')).toBe('alert');
    expect(notificationAriaLive('error')).toBe('assertive');
    for (const kind of ['success', 'warning', 'info', 'loading'] as const) {
      expect(notificationAriaRole(kind)).toBe('status');
      expect(notificationAriaLive(kind)).toBe('polite');
    }
  });
});
