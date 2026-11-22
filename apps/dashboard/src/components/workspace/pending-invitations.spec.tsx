import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { WorkspaceInvitation } from '@project-x/types';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PendingInvitations } from './pending-invitations';

const invitation: WorkspaceInvitation = {
  id: 'inv_1',
  workspaceId: 'ws_1',
  email: 'bob@example.com',
  role: 'admin',
  status: 'pending',
  expiresAt: '2026-12-01T00:00:00.000Z',
  invitedByUserId: 'u_owner',
  createdAt: '2026-11-20T00:00:00.000Z',
};

afterEach(cleanup);

describe('PendingInvitations (M3)', () => {
  it('shows email, role and expiry, and revokes by id', () => {
    const onRevoke = vi.fn();
    render(
      <PendingInvitations
        invitations={[invitation]}
        loading={false}
        revokingId={null}
        onRevoke={onRevoke}
      />,
    );
    expect(screen.getByText('bob@example.com')).toBeTruthy();
    expect(screen.getByText('admin')).toBeTruthy();
    expect(screen.getByText(/Expires/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke invitation for bob@example.com' }));
    expect(onRevoke).toHaveBeenCalledWith('inv_1');
  });

  it('disables revocation while one is in flight (no duplicate submission)', () => {
    const onRevoke = vi.fn();
    render(
      <PendingInvitations
        invitations={[invitation, { ...invitation, id: 'inv_2', email: 'c@example.com' }]}
        loading={false}
        revokingId="inv_1"
        onRevoke={onRevoke}
      />,
    );
    expect(screen.getByText('Revoking…')).toBeTruthy();
    for (const button of screen.getAllByRole('button')) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(button);
    }
    expect(onRevoke).not.toHaveBeenCalled();
  });

  it('renders the empty state and never a token', () => {
    const { container } = render(
      <PendingInvitations invitations={[]} loading={false} revokingId={null} onRevoke={vi.fn()} />,
    );
    expect(screen.getByText('No pending invitations.')).toBeTruthy();
    expect(container.innerHTML).not.toMatch(/token/i);
  });
});
