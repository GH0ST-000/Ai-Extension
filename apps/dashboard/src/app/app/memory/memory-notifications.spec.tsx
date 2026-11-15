import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Toaster, __resetToasterOwnerForTests } from '../../../components/notifications/toaster';
import { ApiError } from '../../../lib/api';
import { notificationStore } from '../../../lib/notify';
import {
  MANAGE_DENIED_MESSAGE,
  WORKSPACE_SELECTION_MESSAGE,
  runMemoryMutation,
} from './memory-notifications';

const snapshot = () =>
  notificationStore
    .getSnapshot()
    .filter((n) => n.open)
    .map((n) => ({ kind: n.kind, title: n.title, description: n.description }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  notificationStore.reset();
});
afterEach(() => {
  cleanup();
  notificationStore.reset();
});

describe('Project Memory mutations report their real outcome', () => {
  it('success is shown only after the server confirmed (no loading → nothing before)', async () => {
    const server = deferred<{ id: string }>();
    const run = runMemoryMutation(() => server.promise, {
      success: { title: 'Rule saved', description: 'Applies to future AI reviews of acme/app.' },
      errorTitle: 'Could not save rule',
    });
    await Promise.resolve();
    expect(snapshot()).toEqual([]);
    server.resolve({ id: 'mem_1' });
    await expect(run).resolves.toEqual({ ok: true, value: { id: 'mem_1' } });
    expect(snapshot()).toEqual([
      {
        kind: 'success',
        title: 'Rule saved',
        description: 'Applies to future AI reviews of acme/app.',
      },
    ]);
  });

  it('long operations: loading → success in the same notification', async () => {
    const server = deferred<{ archived: number }>();
    const run = runMemoryMutation(() => server.promise, {
      loading: 'Clearing project memory…',
      success: (r) => `Cleared ${r.archived} rules`,
      errorTitle: 'Could not clear project memory',
    });
    expect(snapshot()).toEqual([
      { kind: 'loading', title: 'Clearing project memory…', description: undefined },
    ]);
    const loadingId = notificationStore.getSnapshot()[0]!.id;
    server.resolve({ archived: 3 });
    await run;
    expect(notificationStore.getSnapshot()).toHaveLength(1);
    expect(notificationStore.get(loadingId)).toMatchObject({
      kind: 'success',
      title: 'Cleared 3 rules',
    });
  });

  it('loading → error in place, with the safe server message for a 4xx', async () => {
    const run = runMemoryMutation(
      () =>
        Promise.reject(
          new ApiError(
            'This rule conflicts with Project X safety policy and cannot be stored.',
            400,
            'PROJECT_MEMORY_VALIDATION_FAILED',
          ),
        ),
      { loading: 'Learning project context…', success: 'Learned', errorTitle: 'Could not learn' },
    );
    const result = await run;
    expect(result.ok).toBe(false);
    expect(snapshot()).toEqual([
      {
        kind: 'error',
        title: 'Could not learn',
        description: 'This rule conflicts with Project X safety policy and cannot be stored.',
      },
    ]);
  });

  it('server errors and network failures never expose backend details', async () => {
    await runMemoryMutation(
      () =>
        Promise.reject(
          new ApiError('Invalid `prisma.projectMemory.update()` invocation: SELECT …', 500),
        ),
      { success: 'x', errorTitle: 'Could not archive rule' },
    );
    await runMemoryMutation(() => Promise.reject(new TypeError('Failed to fetch')), {
      success: 'x',
      errorTitle: 'Could not save rule',
    });
    await runMemoryMutation(
      () => Promise.reject(new ApiError('token ghp_abcdefghijklmnopqrstuvwxyz0123456789 bad', 400)),
      { success: 'x', errorTitle: 'Could not save rule (secret)' },
    );
    const shown = snapshot();
    expect(shown[0]).toEqual({
      kind: 'error',
      title: 'Could not archive rule',
      description: 'Something went wrong on our side. Try again in a moment.',
    });
    expect(shown[1]).toEqual({
      kind: 'error',
      title: 'Could not save rule',
      description: "Can't reach Project X. Check your connection and try again.",
    });
    expect(JSON.stringify(shown)).not.toMatch(/prisma|SELECT|ghp_/);
  });

  it('403: fixed permission copy and the permissions refresh hook', async () => {
    const onForbidden = vi.fn();
    await runMemoryMutation(
      () => Promise.reject(new ApiError('Insufficient role', 403, 'WORKSPACE_ACCESS_DENIED')),
      { success: 'x', errorTitle: 'Could not archive rule', onForbidden },
    );
    expect(onForbidden).toHaveBeenCalledOnce();
    expect(snapshot()).toEqual([
      { kind: 'error', title: 'Could not archive rule', description: MANAGE_DENIED_MESSAGE },
    ]);
  });

  it('other 403s (GitHub access, plan) show their own reason, not the role message', async () => {
    const onForbidden = vi.fn();
    await runMemoryMutation(
      () =>
        Promise.reject(
          new ApiError(
            'This action needs GitHub access to the repository. Connect a GitHub token in dashboard Settings before using project memory, or ask a workspace Owner to install the Project X GitHub App with access to this repository.',
            403,
            'PROJECT_MEMORY_ACCESS_DENIED',
          ),
        ),
      { success: 'x', errorTitle: 'Could not save preference', onForbidden },
    );
    await runMemoryMutation(
      () =>
        Promise.reject(
          new ApiError(
            'Feature PROJECT_MEMORY is not available on the current plan.',
            403,
            'FEATURE_NOT_AVAILABLE',
          ),
        ),
      { success: 'x', errorTitle: 'Could not save rule', onForbidden },
    );
    expect(onForbidden).not.toHaveBeenCalled();
    const shown = snapshot();
    expect(shown[0]!.description).toMatch(/GitHub App/);
    expect(shown[1]!.description).toBe(
      'Feature PROJECT_MEMORY is not available on the current plan.',
    );
    expect(JSON.stringify(shown)).not.toContain(MANAGE_DENIED_MESSAGE);
  });

  it('rejected workspace selection: warning + workspace refresh hook, nothing claimed as saved', async () => {
    const onWorkspaceSelection = vi.fn();
    const result = await runMemoryMutation(
      () => Promise.reject(new ApiError('nope', 403, 'WORKSPACE_CONTEXT_UNAVAILABLE')),
      { success: 'Rule saved', errorTitle: 'Could not save rule', onWorkspaceSelection },
    );
    expect(result.ok).toBe(false);
    expect(onWorkspaceSelection).toHaveBeenCalledOnce();
    expect(snapshot()).toEqual([
      {
        kind: 'warning',
        title: 'Workspace no longer available',
        description: WORKSPACE_SELECTION_MESSAGE,
      },
    ]);
  });

  it('errors handled inline (edit validation / conflict) raise no notification', async () => {
    const conflict = new ApiError('Changed by someone else.', 409, 'PROJECT_MEMORY_CONFLICT');
    const result = await runMemoryMutation(() => Promise.reject(conflict), {
      loading: 'Saving…',
      success: 'Rule updated',
      errorTitle: 'Could not update rule',
      handledInline: (e) => e instanceof ApiError && e.statusCode === 409,
    });
    expect(result).toEqual({ ok: false, error: conflict });
    expect(snapshot()).toEqual([]);
  });

  it('repeated identical failures do not stack', async () => {
    for (let i = 0; i < 3; i += 1) {
      await runMemoryMutation(() => Promise.reject(new TypeError('Failed to fetch')), {
        success: 'x',
        errorTitle: 'Could not archive rule',
      });
    }
    expect(snapshot()).toHaveLength(1);
    expect(notificationStore.getSnapshot()[0]!.count).toBe(3);
  });

  it('end to end with the renderer: the user sees the confirmed outcome', async () => {
    __resetToasterOwnerForTests();
    render(<Toaster />);
    await act(async () => {
      await runMemoryMutation(() => Promise.resolve({}), {
        success: { title: 'Rule archived', description: 'It no longer applies to AI reviews.' },
        errorTitle: 'Could not archive rule',
      });
    });
    expect(screen.getByLabelText('Success: Rule archived').textContent).toContain(
      'It no longer applies to AI reviews.',
    );
  });
});
