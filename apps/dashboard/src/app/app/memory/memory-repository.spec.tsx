/**
 * Memory page repository selection: restore, auto-load (read-only), stale-response safety,
 * workspace isolation and manual entry. All API calls are mocked — no GitHub, no AI.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ProjectMemoryItem } from '@project-x/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../../lib/api';
import {
  REPOSITORY_STORAGE_KEY,
  rememberRepository,
} from '../../../components/memory/repository-selection';

const { nav, workspace, api } = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const nav = {
    params: new URLSearchParams(),
    listeners,
    replace: vi.fn((url: string) => {
      nav.params = new URLSearchParams(url.split('?')[1] ?? '');
      listeners.forEach((l) => l());
    }),
  };
  return {
    nav,
    workspace: {
      currentWorkspaceId: 'ws_a' as string | null,
      workspaceRevision: 1,
      canManage: true,
      refresh: vi.fn(async () => undefined),
      hasPermission: (() => true) as () => boolean,
    },
    api: {
      listProjectMemory: vi.fn(),
      getProjectMemoryProfile: vi.fn(),
      listSystems: vi.fn(),
      learnProjectMemory: vi.fn(),
      updateProjectMemory: vi.fn(),
      createProjectMemoryRule: vi.fn(),
      listPrReviewHistory: vi.fn(),
    },
  };
});

vi.mock('next/navigation', async () => {
  const React = await import('react');
  return {
    useSearchParams: () =>
      React.useSyncExternalStore(
        (l: () => void) => {
          nav.listeners.add(l);
          return () => nav.listeners.delete(l);
        },
        () => nav.params,
      ),
    useRouter: () => ({ replace: nav.replace, push: vi.fn() }),
  };
});
vi.mock('next/link', () => ({ default: ({ children }: { children: unknown }) => children }));
vi.mock('../../../lib/workspace-context', () => ({
  // Stable callbacks, like the real WorkspaceProvider (useCallback).
  useWorkspace: () => ({
    currentWorkspaceId: workspace.currentWorkspaceId,
    workspaceRevision: workspace.workspaceRevision,
    hasPermission: workspace.hasPermission,
    refresh: workspace.refresh,
  }),
}));
vi.mock('../../../lib/notify', () => ({
  notify: {
    success: vi.fn(),
    apiError: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock('./memory-activity', () => ({ MemoryActivity: () => null }));
vi.mock('../reviews/reviews-data', () => ({
  listPrReviewHistory: (...a: unknown[]) => api.listPrReviewHistory(...a),
}));
vi.mock('../../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked: Record<string, unknown> = {};
  for (const name of Object.keys(api)) {
    if (name === 'listPrReviewHistory') continue;
    mocked[name] = (...args: unknown[]) => api[name as keyof typeof api](...args);
  }
  return { ...actual, ...mocked };
});

import MemoryPage from './page';

function rule(key: string, owner = 'acme', repo = 'one'): ProjectMemoryItem {
  return {
    id: `id-${key}`,
    project: { provider: 'github', owner, repository: repo },
    category: 'testing',
    key,
    value: { summary: `${key} summary` },
    confidence: 'high',
    status: 'active',
    provenance: [{ type: 'user_explicit' }],
    scope: { type: 'repository' },
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  } as unknown as ProjectMemoryItem;
}

/** Memory per `${workspace}:${owner}/${repo}`; a function value lets a test control timing. */
let memory: Record<string, ProjectMemoryItem[] | (() => Promise<ProjectMemoryItem[]>)> = {};
const memoryCalls = () =>
  api.listProjectMemory.mock.calls.filter((c) => c[2] === undefined).map((c) => `${c[0]}/${c[1]}`);

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  window.localStorage.clear();
  nav.params = new URLSearchParams();
  nav.replace.mockClear();
  workspace.currentWorkspaceId = 'ws_a';
  workspace.canManage = true;
  workspace.hasPermission = () => workspace.canManage;
  memory = {};
  for (const fn of Object.values(api)) fn.mockReset();
  api.listProjectMemory.mockImplementation(async (owner: string, repo: string, status?: string) => {
    if (status) return { items: [], memoryVersion: 'v1' };
    const entry = memory[`${workspace.currentWorkspaceId}:${owner}/${repo}`];
    const items = typeof entry === 'function' ? await entry() : (entry ?? []);
    return { items, memoryVersion: 'v1' };
  });
  api.getProjectMemoryProfile.mockResolvedValue(null);
  api.listSystems.mockResolvedValue([]);
  api.listPrReviewHistory.mockResolvedValue({ items: [] });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const combobox = () => screen.getByRole('combobox', { name: 'Repository' });
function pick(text: string) {
  fireEvent.focus(combobox());
  fireEvent.change(combobox(), { target: { value: text } });
  fireEvent.keyDown(combobox(), { key: 'Enter' });
}

describe('Memory repository selection', () => {
  it('no stored selection: explicit empty state, no Memory request', async () => {
    render(<MemoryPage />);
    expect(await screen.findByText('Select a repository to load its memory.')).toBeTruthy();
    expect(api.listProjectMemory).not.toHaveBeenCalled();
  });

  it('restores the workspace’s last repository after refresh and loads it once', async () => {
    rememberRepository('ws_a', { owner: 'acme', repository: 'one' });
    memory['ws_a:acme/one'] = [rule('Use vitest')];
    render(<MemoryPage />);
    expect(await screen.findByText('Use vitest')).toBeTruthy();
    expect((combobox() as HTMLInputElement).value).toBe('acme/one');
    expect(memoryCalls()).toEqual(['acme/one']);
  });

  it('a deep link wins over the stored selection', async () => {
    rememberRepository('ws_a', { owner: 'acme', repository: 'one' });
    nav.params = new URLSearchParams('owner=Acme&repo=Two');
    memory['ws_a:acme/two'] = [rule('Deep linked')];
    render(<MemoryPage />);
    expect(await screen.findByText('Deep linked')).toBeTruthy();
    expect(memoryCalls()).toEqual(['acme/two']);
  });

  it('selecting (or typing) a repository loads its Memory automatically and remembers it', async () => {
    memory['ws_a:acme/two'] = [rule('Two rule')];
    render(<MemoryPage />);
    pick('https://github.com/acme/two');
    expect(await screen.findByText('Two rule')).toBeTruthy();
    expect(nav.params.get('owner')).toBe('acme');
    expect(
      JSON.parse(window.localStorage.getItem(REPOSITORY_STORAGE_KEY)!).workspaces.ws_a,
    ).toEqual({
      last: 'acme/two',
      recent: ['acme/two'],
    });
    // Read-only: loading never learns (no analysis, no AI).
    expect(api.learnProjectMemory).not.toHaveBeenCalled();
  });

  it('rapid switching: a slow response for the previous repository is never shown', async () => {
    const slow = deferred<ProjectMemoryItem[]>();
    memory['ws_a:acme/one'] = () => slow.promise;
    memory['ws_a:acme/two'] = [rule('Two rule')];
    render(<MemoryPage />);
    pick('acme/one');
    await waitFor(() => expect(memoryCalls()).toContain('acme/one'));
    pick('acme/two');
    expect(await screen.findByText('Two rule')).toBeTruthy();
    await act(async () => slow.resolve([rule('One rule (stale)')]));
    expect(screen.queryByText('One rule (stale)')).toBeNull();
    expect(screen.getByText('Two rule')).toBeTruthy();
  });

  it('workspace switch clears immediately, restores that workspace’s selection, never mixes data', async () => {
    rememberRepository('ws_a', { owner: 'acme', repository: 'one' });
    rememberRepository('ws_b', { owner: 'other', repository: 'b-repo' });
    memory['ws_a:acme/one'] = [rule('A private rule')];
    memory['ws_b:other/b-repo'] = [rule('B rule')];
    const view = render(<MemoryPage />);
    expect(await screen.findByText('A private rule')).toBeTruthy();

    workspace.currentWorkspaceId = 'ws_b';
    view.rerender(<MemoryPage />);
    expect(screen.queryByText('A private rule')).toBeNull();
    expect(await screen.findByText('B rule')).toBeTruthy();
    // ws_a's repository was never requested under ws_b.
    expect(memoryCalls()).toEqual(['acme/one', 'other/b-repo']);

    // A workspace without a stored selection shows an explicit empty state.
    workspace.currentWorkspaceId = 'ws_c';
    view.rerender(<MemoryPage />);
    expect(screen.queryByText('B rule')).toBeNull();
    expect(await screen.findByText('Select a repository to load its memory.')).toBeTruthy();
    expect(nav.params.get('owner')).toBeNull();

    // Back to ws_a: its own last selection again.
    workspace.currentWorkspaceId = 'ws_a';
    view.rerender(<MemoryPage />);
    expect(await screen.findByText('A private rule')).toBeTruthy();
  });

  it('a stored repository that is no longer accessible is cleared, not swapped for another', async () => {
    rememberRepository('ws_a', { owner: 'acme', repository: 'other' });
    rememberRepository('ws_a', { owner: 'acme', repository: 'gone' });
    api.listProjectMemory.mockRejectedValue(new ApiError('Repository access is required.', 403));
    render(<MemoryPage />);
    expect(await screen.findByText(/Repository access is required/)).toBeTruthy();
    const stored = JSON.parse(window.localStorage.getItem(REPOSITORY_STORAGE_KEY)!).workspaces.ws_a;
    expect(stored).toEqual({ last: null, recent: ['acme/other'] });
    expect(nav.params.get('repo')).toBe('gone'); // still shown with its error, not replaced
  });

  it('Learn Project Context stays an explicit action on the selected repository', async () => {
    api.learnProjectMemory.mockResolvedValue({ accepted: [], candidates: [], skipped: [] });
    render(<MemoryPage />);
    pick('acme/one');
    await waitFor(() => expect(memoryCalls()).toEqual(['acme/one']));
    expect(api.learnProjectMemory).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Learn Project Context' }));
    await waitFor(() => expect(api.learnProjectMemory).toHaveBeenCalledTimes(1));
    expect(api.learnProjectMemory).toHaveBeenCalledWith('acme', 'one');
  });

  it('Learn is unavailable without a selection or without permission', async () => {
    const view = render(<MemoryPage />);
    const learn = await screen.findByRole('button', { name: 'Learn Project Context' });
    expect((learn as HTMLButtonElement).disabled).toBe(true);
    workspace.canManage = false;
    view.rerender(<MemoryPage />);
    pick('acme/one');
    await waitFor(() => expect(memoryCalls()).toEqual(['acme/one']));
    expect(
      (screen.getByRole('button', { name: 'Learn Project Context' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('suggestions come from Systems and Review History of the active workspace', async () => {
    api.listSystems.mockResolvedValue([
      {
        id: 's1',
        name: 'Test Microservices',
        primaryRepository: {
          provider: 'github',
          owner: 'gh0st-000',
          repository: 'project-x-test-api',
        },
        repositories: [
          {
            repository: {
              provider: 'github',
              owner: 'gh0st-000',
              repository: 'project-x-test-api',
            },
            role: 'backend',
            enabled: true,
            source: 'user_selected',
          },
        ],
        createdAt: '',
        updatedAt: '',
      },
    ]);
    api.listPrReviewHistory.mockResolvedValue({
      items: [{ owner: 'acme', repository: 'billing' }],
    });
    render(<MemoryPage />);
    await waitFor(() =>
      expect(api.listPrReviewHistory).toHaveBeenCalledWith(
        'ws_a',
        { limit: 50 },
        expect.anything(),
      ),
    );
    fireEvent.focus(combobox());
    expect(
      await screen.findByRole('option', { name: 'gh0st-000/project-x-test-api' }),
    ).toBeTruthy();
    expect(screen.getByRole('option', { name: 'acme/billing' })).toBeTruthy();
  });

  it('switching repositories with an unsaved rule asks first; cancelling keeps everything', async () => {
    memory['ws_a:acme/one'] = [rule('One rule')];
    render(<MemoryPage />);
    pick('acme/one');
    expect(await screen.findByText('One rule')).toBeTruthy();
    const textarea = screen.getByRole('textbox', { name: /rule/i });
    fireEvent.change(textarea, { target: { value: 'Draft rule' } });
    pick('acme/two');
    const dialog = await screen.findByRole('dialog', { name: 'Discard unsaved changes?' });
    expect(dialog.textContent).toContain('acme/two');
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    // Back to the draft being written.
    expect(document.activeElement).toBe(textarea);
    expect(nav.params.get('repo')).toBe('one');
    expect((textarea as HTMLTextAreaElement).value).toBe('Draft rule');

    pick('acme/two');
    fireEvent.click(await screen.findByRole('button', { name: 'Discard and switch' }));
    await waitFor(() => expect(nav.params.get('repo')).toBe('two'));
    expect(window.confirm).not.toHaveBeenCalled();
  });
});
