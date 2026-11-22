import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ProjectSystem, RelatedRepositoryCandidate } from '@project-x/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, type RefreshSystemResponse } from '../../../lib/api';

// ── dependencies ─────────────────────────────────────────────────────────────
/** Granted permissions (M4); Owners/Admins by default. */
let workspacePermissions = new Set<string>(['systems:read', 'systems:manage']);
const { workspace, toast, api } = vi.hoisted(() => ({
  workspace: {
    ready: true,
    currentWorkspaceId: 'ws_1',
    workspaceRevision: 1,
    current: null as unknown,
    refresh: vi.fn(),
    hasPermission: (permission: string) => workspacePermissions.has(permission),
  },
  toast: { success: vi.fn(), apiError: vi.fn() },
  api: {
    listSystems: vi.fn(),
    createSystem: vi.fn(),
    deleteSystem: vi.fn(),
    updateSystem: vi.fn(),
    addSystemRepository: vi.fn(),
    removeSystemRepository: vi.fn(),
    updateSystemRepository: vi.fn(),
    listRelationships: vi.fn(),
    refreshSystem: vi.fn(),
    discoverRelationships: vi.fn(),
    getGithubConnection: vi.fn(),
  },
}));
vi.mock('../../../lib/workspace-context', () => ({ useWorkspace: () => workspace }));
vi.mock('../../../lib/notify', () => ({ notify: toast }));
vi.mock('../../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked: Record<string, unknown> = {};
  for (const name of Object.keys(api)) {
    mocked[name] = (...args: unknown[]) => api[name as keyof typeof api](...args);
  }
  return { ...actual, ...mocked };
});

import SystemsPage from './page';

const repo = (owner: string, repository: string) => ({
  provider: 'github' as const,
  owner,
  repository,
});
function system(id: string, name: string, extra: string[] = []): ProjectSystem {
  const primary = repo('acme', `${id}-web`);
  return {
    id,
    name,
    primaryRepository: primary,
    repositories: [
      {
        id: `${id}-r0`,
        repository: primary,
        role: 'frontend',
        enabled: true,
        source: 'user_selected',
      },
      ...extra.map((name, i) => ({
        id: `${id}-r${i + 1}`,
        repository: repo('acme', name),
        role: 'backend' as const,
        enabled: true,
        source: 'user_selected' as const,
      })),
    ],
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
  };
}
const candidate = (
  name: string,
  recommendation: 'suggest_add' | 'do_not_add' = 'suggest_add',
): RelatedRepositoryCandidate => ({
  repository: repo('acme', name),
  relationship: 'api_provider',
  confidence: 'high',
  evidence: [{ summary: 'Calls /v1/payments', filePath: 'src/payments.ts' }],
  recommendation,
});
const ZERO: RefreshSystemResponse = {
  analyzed: 1,
  relationshipsChecked: 0,
  candidates: [],
  unavailable: [],
  truncated: false,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  workspace.workspaceRevision = 1;
  workspace.current = null;
  workspacePermissions = new Set(['systems:read', 'systems:manage']);
  workspace.refresh.mockReset().mockResolvedValue(undefined);
  Object.values(api).forEach((fn) => fn.mockReset());
  toast.success.mockReset();
  toast.apiError.mockReset();
  api.listSystems.mockResolvedValue([system('sys_a', 'Checkout')]);
  api.listRelationships.mockResolvedValue([]);
  api.getGithubConnection.mockResolvedValue({ connected: true });
});
afterEach(() => cleanup());

/** Primary actions live in the selected-system card (empty states may repeat them). */
const cardButton = (name: string) =>
  within(screen.getByRole('region', { name: 'Selected system' })).getByRole('button', { name });

async function renderLoaded() {
  const view = render(<SystemsPage />);
  await screen.findByRole('heading', { name: 'Checkout' });
  await waitFor(() => expect(screen.queryByText('Loading relationships…')).toBeNull());
  return view;
}

describe('/app/systems — structure and empty states', () => {
  it('explains the concepts and shows an overview with real counts only', async () => {
    await renderLoaded();
    expect(screen.getByText('Understand how your repositories work together.')).toBeTruthy();
    for (const term of ['Repository', 'System', 'Relationship']) {
      expect(screen.getByText(term, { selector: 'dt' })).toBeTruthy();
    }
    const overview = screen.getByLabelText('System overview');
    expect(within(overview).getByText('Repositories').nextSibling?.textContent).toBe('1');
    expect(within(overview).getByText('Known relationships').nextSibling?.textContent).toBe('0');
    // No analysis yet → unknown, not an invented 0.
    expect(within(overview).getByText('Pending suggestions').nextSibling?.textContent).toBe('—');
    expect(within(overview).getByText('Unavailable').nextSibling?.textContent).toBe('—');
    expect(screen.getByText('No relationships yet')).toBeTruthy();
    expect(screen.getByText('No suggestions yet')).toBeTruthy();
    expect(screen.getByText(/has only its primary repository/)).toBeTruthy();
  });

  it('no systems → a single clear call to action (no permanent form)', async () => {
    api.listSystems.mockResolvedValue([]);
    render(<SystemsPage />);
    expect(await screen.findByRole('heading', { name: 'Create your first system' })).toBeTruthy();
    expect(screen.queryByLabelText('System name')).toBeNull();
  });

  it('load failure shows an error with retry', async () => {
    api.listSystems.mockRejectedValueOnce(new ApiError('Service unavailable', 503));
    render(<SystemsPage />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/Service unavailable/);
    api.listSystems.mockResolvedValue([system('sys_a', 'Checkout')]);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Checkout' })).toBeTruthy();
  });

  it('shows a calm GitHub notice when no personal connection exists', async () => {
    api.getGithubConnection.mockResolvedValue({ connected: false });
    await renderLoaded();
    expect(await screen.findByText('Connect GitHub to use Systems')).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Connect GitHub in Settings' }).getAttribute('href'),
    ).toBe('/app/settings');
  });
});

describe('creating a system', () => {
  it('validates, accepts a GitHub URL, creates and selects the new system', async () => {
    api.listSystems.mockResolvedValue([]);
    render(<SystemsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create system' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create system' }));
    expect(within(dialog).getByText(/Give the system a name/)).toBeTruthy();
    expect(within(dialog).getByText(/Enter a repository/)).toBeTruthy();
    expect(api.createSystem).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText('System name'), {
      target: { value: 'Payments' },
    });
    fireEvent.change(within(dialog).getByLabelText('Primary repository'), {
      target: { value: 'https://github.com/acme/pay-web.git' },
    });
    const created = system('sys_new', 'Payments');
    api.createSystem.mockResolvedValue(created);
    api.listSystems.mockResolvedValue([created]);
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create system' }));
    });
    expect(api.createSystem).toHaveBeenCalledWith({
      name: 'Payments',
      primaryOwner: 'acme',
      primaryRepository: 'pay-web',
    });
    expect(await screen.findByRole('heading', { name: 'Payments' })).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('API errors stay in the dialog with an actionable next step', async () => {
    api.listSystems.mockResolvedValue([]);
    api.createSystem.mockRejectedValue(
      new ApiError(
        'Connect a GitHub token in dashboard Settings.',
        403,
        'SYSTEM_REPOSITORY_NOT_ACCESSIBLE',
      ),
    );
    render(<SystemsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create system' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('System name'), { target: { value: 'X' } });
    fireEvent.change(within(dialog).getByLabelText('Primary repository'), {
      target: { value: 'acme/x' },
    });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Create system' }));
    });
    expect(within(dialog).getByText('Repository not accessible')).toBeTruthy();
    expect(within(dialog).getByRole('link', { name: 'GitHub settings' })).toBeTruthy();
  });
});

describe('repositories', () => {
  it('adds a repository from the dialog and rejects duplicates locally', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'Add repository' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Repository'), {
      target: { value: 'acme/sys_a-web' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add repository' }));
    expect(within(dialog).getByText(/already in this system/)).toBeTruthy();
    expect(api.addSystemRepository).not.toHaveBeenCalled();

    api.addSystemRepository.mockResolvedValue(system('sys_a', 'Checkout', ['payments-api']));
    fireEvent.change(within(dialog).getByLabelText('Repository'), {
      target: { value: 'acme/payments-api' },
    });
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Add repository' }));
    });
    expect(api.addSystemRepository).toHaveBeenCalledWith('sys_a', {
      owner: 'acme',
      repository: 'payments-api',
      role: 'unknown',
      enabled: true,
      source: 'user_selected',
    });
    expect(screen.getByText('acme/payments-api')).toBeTruthy();
  });

  it('removing a repository requires confirmation', async () => {
    api.listSystems.mockResolvedValue([system('sys_a', 'Checkout', ['payments-api'])]);
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'Remove acme/payments-api from system' }));
    expect(api.removeSystemRepository).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog', { name: 'Remove repository?' });
    api.removeSystemRepository.mockResolvedValue(system('sys_a', 'Checkout'));
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    });
    expect(api.removeSystemRepository).toHaveBeenCalledWith('sys_a', 'acme', 'payments-api');
  });

  it('the primary repository cannot be disabled or removed', async () => {
    await renderLoaded();
    expect(
      (screen.getByRole('switch', { name: 'Analyze acme/sys_a-web' }) as HTMLInputElement).disabled,
    ).toBe(true);
    expect(screen.queryByRole('button', { name: /Remove acme\/sys_a-web/ })).toBeNull();
  });
});

describe('analysis', () => {
  it('zero discoveries: clear success, explanation and an Add repository action', async () => {
    api.refreshSystem.mockResolvedValue(ZERO);
    await renderLoaded();
    await act(async () => {
      fireEvent.click(cardButton('Refresh analysis'));
    });
    expect(screen.getByText('Analysis completed')).toBeTruthy();
    expect(screen.getByText('1 repository analyzed. No relationships found.')).toBeTruthy();
    expect(screen.getByText(/currently contains one repository/)).toBeTruthy();
    expect(screen.getByText('No suggestions to review')).toBeTruthy();
    const overview = screen.getByLabelText('System overview');
    expect(within(overview).getByText('Pending suggestions').nextSibling?.textContent).toBe('0');
    // Technical details are kept, but collapsed.
    expect(screen.getByText('Technical details').closest('details')?.open).toBe(false);
    const actions = screen.getAllByRole('button', { name: 'Add repository' });
    fireEvent.click(actions[0]!);
    expect(await screen.findByRole('dialog', { name: 'Add repository' })).toBeTruthy();
  });

  it('candidates, unavailable repositories and truncation are reported as warnings', async () => {
    api.refreshSystem.mockResolvedValue({
      analyzed: 2,
      relationshipsChecked: 3,
      candidates: [candidate('payments-api'), candidate('legacy-api', 'do_not_add')],
      unavailable: [repo('acme', 'private-svc')],
      truncated: true,
    });
    await renderLoaded();
    await act(async () => {
      fireEvent.click(cardButton('Refresh analysis'));
    });
    expect(screen.getByText('Analysis completed with warnings')).toBeTruthy();
    expect(
      screen.getByText(
        '2 repositories analyzed. 3 relationships found. 2 related repositories suggested for review.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('1 repository could not be analyzed')).toBeTruthy();
    expect(screen.getByText(/acme\/private-svc/)).toBeTruthy();
    expect(screen.getByText('Partial results.')).toBeTruthy();

    // Suggestions are never added automatically; "not recommended" cannot be added.
    expect(api.addSystemRepository).not.toHaveBeenCalled();
    expect(
      (screen.getByRole('button', { name: 'Add acme/legacy-api to system' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    api.addSystemRepository.mockResolvedValue(system('sys_a', 'Checkout', ['payments-api']));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add acme/payments-api to system' }));
    });
    expect(api.addSystemRepository).toHaveBeenCalledWith(
      'sys_a',
      expect.objectContaining({
        owner: 'acme',
        repository: 'payments-api',
        source: 'deterministic_link',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss acme/legacy-api' }));
    expect(screen.queryByText('acme/legacy-api')).toBeNull();
  });

  it('failure shows guidance and a safe retry', async () => {
    api.refreshSystem.mockRejectedValueOnce(new ApiError('Upstream error', 502));
    await renderLoaded();
    await act(async () => {
      fireEvent.click(cardButton('Refresh analysis'));
    });
    expect(screen.getByText('Analysis failed')).toBeTruthy();
    api.refreshSystem.mockResolvedValue(ZERO);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });
    expect(api.refreshSystem).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Analysis completed')).toBeTruthy();
  });

  it('plan limits are not offered as retry', async () => {
    api.discoverRelationships.mockRejectedValue(new ApiError('Limit', 402, 'USAGE_LIMIT_REACHED'));
    await renderLoaded();
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Discover relationships' })[0]!);
    });
    expect(screen.getByText('Analysis limit reached')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Plan & usage' }).getAttribute('href')).toBe(
      '/app/billing',
    );
  });

  it('discovery shows relationships with evidence', async () => {
    api.listSystems.mockResolvedValue([system('sys_a', 'Checkout', ['payments-api'])]);
    api.discoverRelationships.mockResolvedValue({
      systemId: 'sys_a',
      truncated: false,
      candidates: [],
      relationships: [
        {
          id: 'rel_1',
          from: repo('acme', 'sys_a-web'),
          to: repo('acme', 'payments-api'),
          type: 'HTTP_CALLS',
          resource: { kind: 'http_operation', key: 'POST /v1/payments' },
          confidence: 'high',
          provenance: [
            {
              type: 'http_call',
              filePath: 'src/pay.ts',
              summary: 'fetch to /v1/payments',
              observedAt: '2026-11-17T10:00:00.000Z',
            },
          ],
          status: 'active',
          lastValidatedAt: '2026-11-17T10:00:00.000Z',
        },
      ],
    });
    await renderLoaded();
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Discover relationships' })[0]!);
    });
    expect(screen.getByText('Discovery completed')).toBeTruthy();
    expect(screen.getByText('Calls HTTP API')).toBeTruthy();
    expect(screen.getByText('POST /v1/payments')).toBeTruthy();
    expect(screen.getByText('High confidence')).toBeTruthy();
    expect(screen.getByText('Evidence (1)')).toBeTruthy();
    expect(screen.getByText(/Relationships validated/)).toBeTruthy();
  });

  it('prevents duplicate submissions while an analysis runs', async () => {
    const pending = deferred<typeof ZERO>();
    api.refreshSystem.mockReturnValue(pending.promise);
    await renderLoaded();
    const button = cardButton('Refresh analysis');
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(screen.getAllByRole('button', { name: 'Discover relationships' })[0]!);
    expect(api.refreshSystem).toHaveBeenCalledTimes(1);
    expect(api.discoverRelationships).not.toHaveBeenCalled();
    expect(cardButton('Analyzing…').hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/Analyzing repositories/)).toBeTruthy();
    await act(async () => pending.resolve(ZERO));
    expect(screen.getByText('Analysis completed')).toBeTruthy();
  });

  it('a slow result never appears under another system', async () => {
    api.listSystems.mockResolvedValue([system('sys_a', 'Checkout'), system('sys_b', 'Billing')]);
    const pending = deferred<typeof ZERO>();
    api.refreshSystem.mockReturnValue(pending.promise);
    await renderLoaded();
    fireEvent.click(cardButton('Refresh analysis'));
    fireEvent.click(screen.getByLabelText('System'));
    fireEvent.click(screen.getByRole('option', { name: /Billing/ }));
    expect(await screen.findByRole('heading', { name: 'Billing' })).toBeTruthy();
    await act(async () => pending.resolve({ ...ZERO, candidates: [candidate('payments-api')] }));
    expect(screen.queryByText('Analysis completed')).toBeNull();
    expect(screen.queryByText('acme/payments-api')).toBeNull();
    expect((cardButton('Refresh analysis') as HTMLButtonElement).disabled).toBe(false);
    expect(api.listRelationships).toHaveBeenLastCalledWith('sys_b');
  });
});

describe('workspace switching and destructive actions', () => {
  it('switching workspace reloads systems and clears previous results', async () => {
    api.refreshSystem.mockResolvedValue(ZERO);
    const view = await renderLoaded();
    await act(async () => {
      fireEvent.click(cardButton('Refresh analysis'));
    });
    expect(screen.getByText('Analysis completed')).toBeTruthy();
    api.listSystems.mockResolvedValue([system('sys_z', 'Other workspace system')]);
    workspace.workspaceRevision = 2;
    view.rerender(<SystemsPage />);
    expect(await screen.findByRole('heading', { name: 'Other workspace system' })).toBeTruthy();
    expect(screen.queryByText('Analysis completed')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Checkout' })).toBeNull();
    expect(api.listSystems).toHaveBeenCalledTimes(2);
  });

  it('deleting a system requires an explicit confirmation step', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'System settings' }));
    const dialog = await screen.findByRole('dialog', { name: 'System settings' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete system…' }));
    expect(api.deleteSystem).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep system' }));
    expect(api.deleteSystem).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete system…' }));
    api.deleteSystem.mockResolvedValue(undefined);
    api.listSystems.mockResolvedValue([]);
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Yes, delete system' }));
    });
    expect(api.deleteSystem).toHaveBeenCalledWith('sys_a');
    expect(await screen.findByRole('heading', { name: 'Create your first system' })).toBeTruthy();
  });

  it('destructive actions are not placed next to the primary analysis actions', async () => {
    await renderLoaded();
    const card = screen.getByRole('region', { name: 'Selected system' });
    expect(within(card).queryByRole('button', { name: /Delete/ })).toBeNull();
  });
});

// ── final-review regressions ─────────────────────────────────────────────────

function workspaceWith(
  usage: { count: number; limit: number | null; remaining: number | null; period?: string },
  multiRepo = true,
) {
  const now = new Date();
  const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  return {
    entitlements: { multiRepoIntelligence: multiRepo },
    usage: [{ workspaceId: 'ws_1', metric: 'multi_repo_analysis', period, ...usage }],
  };
}

describe('usage transparency', () => {
  it('explains that Refresh and Discover both count toward usage and shows what is left', async () => {
    workspace.current = workspaceWith({ count: 7, limit: 10, remaining: 3 });
    await renderLoaded();
    const card = screen.getByRole('region', { name: 'Selected system' });
    expect(within(card).getByText(/each Refresh or Discover/)).toBeTruthy();
    expect(within(card).getByText(/Viewing saved relationships is free/)).toBeTruthy();
    expect(within(card).getByText('3 of 10 left this month.')).toBeTruthy();
  });

  it('no analyses left: both scans are disabled up front', async () => {
    workspace.current = workspaceWith({ count: 10, limit: 10, remaining: 0 });
    await renderLoaded();
    expect((cardButton('Discover relationships') as HTMLButtonElement).disabled).toBe(true);
    expect((cardButton('Refresh analysis') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/No analyses left this month/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Plan & usage' }).getAttribute('href')).toBe(
      '/app/billing',
    );
  });

  it('stale usage from a previous month is not shown', async () => {
    workspace.current = workspaceWith({ count: 10, limit: 10, remaining: 0, period: '2000-01' });
    await renderLoaded();
    expect(screen.queryByText(/left this month|No analyses left/)).toBeNull();
    expect((cardButton('Discover relationships') as HTMLButtonElement).disabled).toBe(false);
  });

  it('re-reads workspace usage after every scan', async () => {
    api.refreshSystem.mockResolvedValue(ZERO);
    api.discoverRelationships.mockResolvedValue({
      systemId: 'sys_a',
      relationships: [],
      candidates: [],
      truncated: false,
    });
    await renderLoaded();
    await act(async () => {
      fireEvent.click(cardButton('Refresh analysis'));
    });
    expect(workspace.refresh).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.click(cardButton('Discover relationships'));
    });
    expect(workspace.refresh).toHaveBeenCalledTimes(2);
  });

  it('partial scans explain which repository was only partly read and why', async () => {
    api.refreshSystem.mockResolvedValue({
      ...ZERO,
      scan: {
        partial: true,
        githubRequests: 9,
        repositories: [
          {
            repository: repo('acme', 'sys_a-web'),
            status: 'partial',
            filesScanned: 3,
            issues: [
              { code: 'rate_limited', count: 1 },
              { code: 'file_unreadable', count: 2 },
            ],
            unresolvedHttpCalls: 2,
          },
        ],
      },
    });
    await renderLoaded();
    await act(async () => {
      fireEvent.click(cardButton('Refresh analysis'));
    });
    expect(screen.getByText('Analysis completed with warnings')).toBeTruthy();
    expect(
      screen.getByText(
        'acme/sys_a-web was only partly read: GitHub rate limit reached, some files could not be read.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(/2 HTTP calls could not be matched to exactly one repository/),
    ).toBeTruthy();
  });

  it('a scan already running for this system is explained, not retried', async () => {
    api.refreshSystem.mockRejectedValue(new ApiError('busy', 409, 'AI_OPERATION_IN_PROGRESS'));
    await renderLoaded();
    await act(async () => {
      fireEvent.click(cardButton('Refresh analysis'));
    });
    expect(screen.getByText('An analysis is already running')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('plan without Systems: explained up front; create and discover disabled', async () => {
    workspace.current = workspaceWith({ count: 0, limit: null, remaining: null }, false);
    await renderLoaded();
    expect(screen.getByText('Systems are not included in your current plan')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Create system' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((cardButton('Discover relationships') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('review fixes', () => {
  it('a suggestion already in the system is not offered again', async () => {
    api.listSystems.mockResolvedValue([system('sys_a', 'Checkout', ['payments-api'])]);
    api.refreshSystem.mockResolvedValue({
      ...ZERO,
      analyzed: 2,
      candidates: [candidate('payments-api'), candidate('ledger')],
    });
    await renderLoaded();
    await act(async () => {
      fireEvent.click(cardButton('Refresh analysis'));
    });
    expect(screen.queryByRole('button', { name: 'Add acme/payments-api to system' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Add acme/ledger to system' })).toBeTruthy();
  });

  it('dismissing the result keeps the "no relationships found" meaning; empty-state action does not use quota', async () => {
    api.refreshSystem.mockResolvedValue(ZERO);
    await renderLoaded();
    await act(async () => {
      fireEvent.click(cardButton('Refresh analysis'));
    });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Analysis completed')).toBeNull();
    expect(screen.getByText('No relationships found')).toBeTruthy();
    const empty = screen.getByText('No relationships found').parentElement!;
    await act(async () => {
      fireEvent.click(within(empty).getByRole('button', { name: 'Refresh analysis' }));
    });
    expect(api.refreshSystem).toHaveBeenCalledTimes(2);
    expect(api.discoverRelationships).not.toHaveBeenCalled();
  });

  it('form dialogs focus their first field', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: 'Add repository' }));
    const add = await screen.findByRole('dialog', { name: 'Add repository' });
    expect(document.activeElement).toBe(within(add).getByLabelText('Repository'));
    fireEvent.click(within(add).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create system' }));
    const create = await screen.findByRole('dialog', { name: 'Create system' });
    expect(document.activeElement).toBe(within(create).getByLabelText('System name'));
  });

  it('each repository row’s controls are named by the repository', async () => {
    api.listSystems.mockResolvedValue([system('sys_a', 'Checkout', ['payments-api'])]);
    await renderLoaded();
    const group = screen.getByRole('group', { name: 'acme/payments-api' });
    expect(within(group).getByRole('switch', { name: 'Analyze acme/payments-api' })).toBeTruthy();
    expect(within(group).getByLabelText('Role')).toBeTruthy();
  });

  it('brings a finished result into view (results can render below the fold on phones)', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      api.refreshSystem.mockResolvedValue(ZERO);
      await renderLoaded();
      await act(async () => {
        fireEvent.click(cardButton('Refresh analysis'));
      });
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'smooth' });
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });
});

describe('M4 — Members (systems:read without systems:manage)', () => {
  beforeEach(() => {
    workspacePermissions = new Set(['systems:read']);
    api.listSystems.mockResolvedValue([system('sys_a', 'Checkout', ['payments-api'])]);
  });

  it('read-only: no create, settings, add, role change or remove; analysis stays available', async () => {
    await renderLoaded();
    expect(screen.queryByRole('button', { name: 'Create system' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'System settings' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add repository' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove .* from system/ })).toBeNull();
    expect(screen.queryByLabelText('Role')).toBeNull();
    for (const toggle of screen.getAllByRole('switch')) {
      expect((toggle as HTMLInputElement).disabled).toBe(true);
    }
    // Discover / Refresh remain (product decision: systems:read).
    expect((cardButton('Discover relationships') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText('payments-api', { exact: false })).toBeTruthy();
  });

  it('suggestions cannot be added to the system', async () => {
    api.discoverRelationships.mockResolvedValue({
      systemId: 'sys_a',
      relationships: [],
      candidates: [candidate('ledger')],
      truncated: false,
    });
    await renderLoaded();
    fireEvent.click(cardButton('Discover relationships'));
    expect(await screen.findByText('acme/ledger', { exact: false })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Add acme\/ledger to system/ })).toBeNull();
  });

  it('no systems: explains who can create one instead of offering the action', async () => {
    api.listSystems.mockResolvedValue([]);
    render(<SystemsPage />);
    expect(await screen.findByRole('heading', { name: 'No systems yet' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create system' })).toBeNull();
    expect(screen.getByText(/created by workspace Owners and Admins/)).toBeTruthy();
  });
});
