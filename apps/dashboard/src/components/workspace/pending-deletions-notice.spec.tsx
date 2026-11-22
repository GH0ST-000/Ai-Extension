import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = { listPendingDeletions: vi.fn(), deleteWorkspace: vi.fn() };
vi.mock('../../lib/workspace-api', () => ({
  listPendingDeletions: () => api.listPendingDeletions(),
  deleteWorkspace: (id: string) => api.deleteWorkspace(id),
}));

import { PendingDeletionsNotice } from './pending-deletions-notice';

const pending = {
  workspaceId: 'ws_1',
  name: 'Acme',
  openCancellations: 1,
  lastErrorCode: 'provider_error',
  nextAttemptAt: '2026-11-20T10:00:00.000Z',
};

beforeEach(() => {
  api.listPendingDeletions.mockReset();
  api.deleteWorkspace.mockReset();
});
afterEach(cleanup);

describe('PendingDeletionsNotice (N-2)', () => {
  it('renders nothing when there are no pending deletions', async () => {
    api.listPendingDeletions.mockResolvedValue([]);
    const { container } = render(<PendingDeletionsNotice />);
    await waitFor(() => expect(api.listPendingDeletions).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });

  it('lists a pending deletion and retries it once (button disabled while running)', async () => {
    api.listPendingDeletions.mockResolvedValueOnce([pending]).mockResolvedValue([]);
    let finish!: () => void;
    api.deleteWorkspace.mockReturnValue(new Promise<void>((r) => (finish = r)));
    render(<PendingDeletionsNotice />);
    const button = await screen.findByRole('button', { name: 'Retry deleting Acme' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(api.deleteWorkspace).toHaveBeenCalledTimes(1);
    expect((button as HTMLButtonElement).disabled).toBe(true);
    finish();
    expect(await screen.findByRole('status')).toBeTruthy();
  });
});
