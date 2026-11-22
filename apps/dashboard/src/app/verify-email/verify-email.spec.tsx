import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../lib/api';

vi.mock('../../components/theme-toggle', () => ({ ThemeToggle: () => null }));

/** Plain double (not a spy): the page handles the rejection itself. */
let confirmImpl: (token: string) => Promise<unknown> = async () => ({ verified: true });
const calls: string[] = [];
vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  confirmEmailVerification: (token: string) => {
    calls.push(token);
    return confirmImpl(token);
  },
}));

import VerifyEmailPage from './page';

const TOKEN = 'A'.repeat(43);
beforeEach(() => {
  calls.length = 0;
  confirmImpl = async () => ({ verified: true });
  window.sessionStorage.clear();
});
afterEach(cleanup);

describe('/verify-email (Decision A)', () => {
  it('confirms once with the fragment token, then removes it from the address bar', async () => {
    window.history.replaceState(null, '', `/verify-email#token=${TOKEN}`);
    render(<VerifyEmailPage />);
    expect(await screen.findByText(/Your email address is confirmed/)).toBeTruthy();
    expect(calls).toEqual([TOKEN]);
    expect(window.location.hash).toBe('');
  });

  it('an expired link is explained', async () => {
    window.history.replaceState(null, '', `/verify-email#token=${TOKEN}`);
    confirmImpl = async () => {
      throw new ApiError('expired', 400, 'EMAIL_VERIFICATION_EXPIRED');
    };
    render(<VerifyEmailPage />);
    expect(await screen.findByText(/has expired/)).toBeTruthy();
  });

  it('a link without a token is invalid (no API call)', async () => {
    window.history.replaceState(null, '', '/verify-email');
    render(<VerifyEmailPage />);
    expect(await screen.findByText(/invalid or was already used/)).toBeTruthy();
    expect(calls).toEqual([]);
  });

  // F-05: the link alone confirms nothing — the account's own session is required.
  it('signed out: asks to sign in, keeps the token for this tab only, never in a URL', async () => {
    window.history.replaceState(null, '', `/verify-email#token=${TOKEN}`);
    confirmImpl = async () => {
      throw new ApiError('Unauthorized', 401);
    };
    render(<VerifyEmailPage />);
    const link = (await screen.findByText('Sign in to confirm')) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/login?next=%2Fverify-email');
    expect(link.getAttribute('href')).not.toContain(TOKEN);
    expect(window.location.href).not.toContain(TOKEN);
    expect(window.sessionStorage.getItem('px.pendingEmailVerification')).toBe(TOKEN);
    expect(screen.queryByText(/Your email address is confirmed/)).toBeNull();
  });

  it('back from sign-in (no fragment): resumes with the kept token and then forgets it', async () => {
    window.sessionStorage.setItem('px.pendingEmailVerification', TOKEN);
    window.history.replaceState(null, '', '/verify-email');
    render(<VerifyEmailPage />);
    expect(await screen.findByText(/Your email address is confirmed/)).toBeTruthy();
    expect(calls).toEqual([TOKEN]);
    expect(window.sessionStorage.getItem('px.pendingEmailVerification')).toBeNull();
  });

  it('signed in as another account: explains and offers to switch, without confirming', async () => {
    window.history.replaceState(null, '', `/verify-email#token=${TOKEN}`);
    confirmImpl = async () => {
      throw new ApiError('wrong', 403, 'EMAIL_VERIFICATION_WRONG_ACCOUNT');
    };
    render(<VerifyEmailPage />);
    expect(await screen.findByText(/different account/)).toBeTruthy();
    expect(screen.getByText('Switch account')).toBeTruthy();
    expect(screen.queryByText(/Your email address is confirmed/)).toBeNull();
  });

  it('a used or invalid link forgets any kept token', async () => {
    window.sessionStorage.setItem('px.pendingEmailVerification', TOKEN);
    window.history.replaceState(null, '', '/verify-email');
    confirmImpl = async () => {
      throw new ApiError('invalid', 400, 'EMAIL_VERIFICATION_INVALID');
    };
    render(<VerifyEmailPage />);
    expect(await screen.findByText(/invalid or was already used/)).toBeTruthy();
    expect(window.sessionStorage.getItem('px.pendingEmailVerification')).toBeNull();
  });
});
