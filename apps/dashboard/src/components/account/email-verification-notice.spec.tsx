import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = { getEmailVerificationStatus: vi.fn(), resendEmailVerification: vi.fn() };
vi.mock('../../lib/api', () => ({
  getEmailVerificationStatus: () => api.getEmailVerificationStatus(),
  resendEmailVerification: () => api.resendEmailVerification(),
}));

import { EmailVerificationNotice } from './email-verification-notice';

beforeEach(() => Object.values(api).forEach((fn) => fn.mockReset()));
afterEach(cleanup);

describe('EmailVerificationNotice (Decision A)', () => {
  it('renders nothing for a verified account', async () => {
    api.getEmailVerificationStatus.mockResolvedValue({ email: 'a@b.c', verified: true });
    const { container } = render(<EmailVerificationNotice />);
    await waitFor(() => expect(api.getEmailVerificationStatus).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });

  it('shows the pending state and resends once (button disabled while sending)', async () => {
    api.getEmailVerificationStatus.mockResolvedValue({ email: 'a@b.c', verified: false });
    let finish!: (v: { status: 'sent' }) => void;
    api.resendEmailVerification.mockReturnValue(new Promise((r) => (finish = r)));
    render(<EmailVerificationNotice />);
    expect(await screen.findByText(/Confirm your email address \(a@b\.c\)/)).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Resend link' });
    fireEvent.click(button);
    fireEvent.click(screen.getByRole('button', { name: 'Sending…' }));
    expect(api.resendEmailVerification).toHaveBeenCalledTimes(1);
    finish({ status: 'sent' });
    expect(await screen.findByText(/We sent a new verification link/)).toBeTruthy();
  });

  it('throttled resend is explained', async () => {
    api.getEmailVerificationStatus.mockResolvedValue({ email: 'a@b.c', verified: false });
    api.resendEmailVerification.mockResolvedValue({ status: 'throttled' });
    render(<EmailVerificationNotice />);
    fireEvent.click(await screen.findByRole('button', { name: 'Resend link' }));
    expect(await screen.findByText(/A link was sent recently/)).toBeTruthy();
  });
});
