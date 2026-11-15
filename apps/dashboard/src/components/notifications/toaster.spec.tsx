import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createNotificationStore, createNotifier, type NotificationStore } from '@project-x/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { notify, notificationStore } from '../../lib/notify';
import { Toaster, __resetToasterOwnerForTests } from './toaster';

let store: NotificationStore;
let n: ReturnType<typeof createNotifier>;

beforeEach(() => {
  vi.useFakeTimers();
  __resetToasterOwnerForTests();
  store = createNotificationStore({ exitDurationMs: 180 });
  n = createNotifier(store);
});

afterEach(() => {
  cleanup();
  store.reset();
  notificationStore.reset();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const regions = () => screen.queryAllByRole('region', { name: /notifications/i });
const toasts = () => document.querySelectorAll('[data-toast]');
const live = (kind: 'polite' | 'assertive') =>
  screen.getByTestId(`toaster-live-${kind}`).textContent;

describe('<Toaster>', () => {
  it('mounts once: a second instance renders nothing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    render(
      <>
        <Toaster store={store} />
        <Toaster store={store} />
      </>,
    );
    expect(regions()).toHaveLength(1);
    act(() => void n.info('Only once'));
    // One visual toast (the text also appears once in the screen-reader live region).
    expect(toasts()).toHaveLength(1);
    expect(live('polite')).toBe('Only once');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('already mounted'));
  });

  it('renders kind, title and description and announces politely / assertively', () => {
    render(<Toaster store={store} />);
    act(() => void n.success('Rule saved', 'Applied to the next review.'));
    const item = screen.getByLabelText('Success: Rule saved');
    expect(within(item).getByText('Applied to the next review.')).toBeTruthy();
    expect(live('polite')).toBe('Rule saved. Applied to the next review.');

    act(() => void n.error('Could not save', 'Check your connection.'));
    expect(live('assertive')).toBe('Could not save. Check your connection.');
    expect(screen.getByLabelText('Error: Could not save').getAttribute('data-kind')).toBe('error');
  });

  it('loading → success updates the same notification and announces the outcome', () => {
    render(<Toaster store={store} />);
    let id = '';
    act(() => void (id = n.loading('Saving rule…')));
    expect(toasts()).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Dismiss notification' })).toBeNull();
    act(() => void n.update(id, { kind: 'success', title: 'Rule saved' }));
    expect(toasts()).toHaveLength(1);
    expect(screen.getByLabelText('Success: Rule saved')).toBeTruthy();
    expect(live('polite')).toBe('Rule saved');
  });

  it('loading → error through notify.promise', async () => {
    render(<Toaster store={store} />);
    const failing = n.promise(Promise.reject(new Error('x')), {
      loading: 'Learning…',
      success: 'Learned',
      error: { title: 'Could not learn', description: 'Try again.' },
    });
    await act(async () => {
      await failing.catch(() => undefined);
    });
    expect(screen.getByLabelText('Error: Could not learn')).toBeTruthy();
    expect(live('assertive')).toBe('Could not learn. Try again.');
  });

  it('close button and Escape dismiss; the element is removed after the exit animation', () => {
    render(<Toaster store={store} />);
    act(() => {
      n.info('First');
      n.info('Second');
    });
    fireEvent.click(
      within(screen.getByLabelText('Info: First')).getByRole('button', {
        name: 'Dismiss notification',
      }),
    );
    expect(screen.getByLabelText('Info: First').getAttribute('data-state')).toBe('closed');
    act(() => void vi.advanceTimersByTime(180));
    expect(screen.queryByLabelText('Info: First')).toBeNull();

    const second = screen.getByLabelText('Info: Second');
    second.focus();
    fireEvent.keyDown(second, { key: 'Escape' });
    act(() => void vi.advanceTimersByTime(180));
    expect(toasts()).toHaveLength(0);
  });

  it('auto-dismisses, and hovering pauses the timer', () => {
    render(<Toaster store={store} />);
    act(() => void n.success('Saved'));
    const list = document.querySelector('ol')!;
    fireEvent.mouseEnter(list);
    act(() => void vi.advanceTimersByTime(30_000));
    expect(screen.getByLabelText('Success: Saved')).toBeTruthy();
    fireEvent.mouseLeave(list);
    act(() => void vi.advanceTimersByTime(4_000 + 180));
    expect(toasts()).toHaveLength(0);
  });

  it('F8 moves focus to the newest notification', () => {
    render(<Toaster store={store} />);
    act(() => {
      n.info('Older');
      n.warning('Newest');
    });
    fireEvent.keyDown(window, { key: 'F8' });
    expect(document.activeElement).toBe(screen.getByLabelText('Warning: Newest'));
  });

  it('duplicate notifications collapse into one with a counter', () => {
    render(<Toaster store={store} />);
    act(() => {
      n.error('Network error', 'Try again.');
      n.error('Network error', 'Try again.');
    });
    expect(toasts()).toHaveLength(1);
    expect(screen.getByLabelText('2 times').textContent).toBe('×2');
  });

  it('navigation: notifications survive a renderer remount, and no duplicate renderer appears', () => {
    const first = render(<Toaster store={store} />);
    act(() => void n.success('Rule saved'));
    first.unmount(); // e.g. a layout boundary re-rendering during navigation
    render(<Toaster store={store} />);
    expect(regions()).toHaveLength(1);
    expect(screen.getByLabelText('Success: Rule saved')).toBeTruthy();
    // Timers keep running independently of the renderer: no leak, normal dismissal.
    act(() => void vi.advanceTimersByTime(4_000 + 180));
    expect(toasts()).toHaveLength(0);
  });

  it('the app-wide notify instance feeds the default renderer; apiError never leaks internals', () => {
    render(<Toaster />);
    act(() => {
      notify.apiError(
        'Could not save rule',
        Object.assign(new Error('Invalid `prisma.projectMemory.update()` invocation'), {
          statusCode: 500,
        }),
      );
    });
    const item = screen.getByLabelText('Error: Could not save rule');
    expect(item.textContent).toContain('Something went wrong on our side');
    expect(item.textContent).not.toMatch(/prisma/i);
  });
});

describe('app wiring', () => {
  it('the app mounts exactly one <Toaster>, in the root layout', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join, relative } = await import('node:path');
    const srcRoot = join(__dirname, '../..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx$/.test(name) && !/\.spec\.tsx$/.test(name)) files.push(path);
      }
    };
    walk(srcRoot);
    // The component's own file only documents it; every other match is a mount.
    const mounts = files.filter(
      (f) => !f.endsWith('toaster.tsx') && /<Toaster\b/.test(readFileSync(f, 'utf8')),
    );
    expect(mounts.map((f) => relative(srcRoot, f))).toEqual(['app/layout.tsx']);
  });
});
