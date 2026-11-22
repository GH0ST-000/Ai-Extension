import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const limits = vi.fn();
vi.mock('../lib/workspace-api', () => ({ getWorkspaceLimits: () => limits() }));
vi.mock('../lib/workspace-context', () => ({
  useWorkspace: () => ({
    ready: true,
    workspaces: [{ id: 'ws_1', name: 'Acme', role: 'owner' }],
    current: { workspace: { id: 'ws_1', name: 'Acme' } },
    switchWorkspace: vi.fn(),
    createWorkspace: vi.fn(),
  }),
}));

import { WorkspaceSwitcher } from './workspace-switcher';

beforeEach(() => limits.mockReset());
afterEach(cleanup);

describe('WorkspaceSwitcher free-workspace limit (Decision B)', () => {
  it('shows usage and allows creating below the limit', async () => {
    limits.mockResolvedValue({ used: 1, limit: 2, canCreate: true });
    render(<WorkspaceSwitcher />);
    fireEvent.click(screen.getByRole('button', { name: /Workspace/ }));
    expect(await screen.findByText(/Free workspaces: 1 of 2/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Create workspace' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('at the limit: create is disabled, the reason and an upgrade path are shown', async () => {
    limits.mockResolvedValue({ used: 2, limit: 2, canCreate: false });
    render(<WorkspaceSwitcher />);
    fireEvent.click(screen.getByRole('button', { name: /Workspace/ }));
    expect(await screen.findByText(/limit reached/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Create workspace' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByRole('link', { name: 'Upgrade a workspace' }).getAttribute('href')).toBe(
      '/app/billing',
    );
  });
});
