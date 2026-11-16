import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../components/theme-toggle', () => ({ ThemeToggle: () => null }));
const requestPasswordReset = vi.fn();
const confirmPasswordReset = vi.fn();
vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    requestPasswordReset: (...a: unknown[]) => requestPasswordReset(...a),
    confirmPasswordReset: (...a: unknown[]) => confirmPasswordReset(...a),
  };
});

import { ApiError } from '../../lib/api';
import ForgotPasswordPage from '../forgot-password/page';
import { FORGOT_PASSWORD_CONFIRMATION } from '../forgot-password/messages';
import ResetPasswordPage from './page';
import { passwordProblem, readResetTokenFromHash } from './reset-token';

const TOKEN = 'A'.repeat(43);

beforeEach(() => {
  requestPasswordReset.mockReset();
  confirmPasswordReset.mockReset();
  window.history.replaceState(null, '', '/');
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => cleanup());

describe('helpers', () => {
  it('reads only a well-formed token from the fragment', () => {
    expect(readResetTokenFromHash(`#token=${TOKEN}`)).toBe(TOKEN);
    expect(readResetTokenFromHash('')).toBeNull();
    expect(readResetTokenFromHash('#token=')).toBeNull();
    expect(readResetTokenFromHash('#token=abc')).toBeNull();
    expect(readResetTokenFromHash('#token=<script>alert(1)</script>xxxxxxxxxx')).toBeNull();
  });

  it('applies the registration password rules and requires matching confirmation', () => {
    expect(passwordProblem('short', 'short')).toMatch(/at least 8/);
    expect(passwordProblem('x'.repeat(129), 'x'.repeat(129))).toMatch(/at most 128/);
    expect(passwordProblem('long-enough-1', 'long-enough-2')).toMatch(/do not match/);
    expect(passwordProblem('long-enough-1', 'long-enough-1')).toBeNull();
  });
});

describe('/forgot-password', () => {
  it('submits the email and shows the same generic confirmation', async () => {
    requestPasswordReset.mockResolvedValue({ ok: true, message: 'x' });
    render(<ForgotPasswordPage />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: ' dev@example.com ' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    });
    expect(requestPasswordReset).toHaveBeenCalledWith('dev@example.com');
    expect(screen.getByRole('status').textContent).toBe(FORGOT_PASSWORD_CONFIRMATION);
    expect(screen.getByRole('link', { name: 'Back to sign in' }).getAttribute('href')).toBe(
      '/login',
    );
  });

  it('shows a safe error when the request cannot be sent (e.g. rate limited)', async () => {
    requestPasswordReset.mockRejectedValue(
      new ApiError('Too many requests. Please wait and try again.', 429, 'RATE_LIMITED'),
    );
    render(<ForgotPasswordPage />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'dev@example.com' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    });
    expect(screen.getByRole('alert').textContent).toMatch(/Too many requests/);
  });
});

describe('/reset-password', () => {
  it('takes the token from the fragment, removes it from the URL, and never stores it', async () => {
    window.history.replaceState(null, '', `/reset-password#token=${TOKEN}`);
    render(<ResetPasswordPage />);
    await screen.findByLabelText('New password');
    expect(window.location.hash).toBe('');
    expect(window.location.href).not.toContain(TOKEN);
    expect(JSON.stringify({ ...localStorage })).not.toContain(TOKEN);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(TOKEN);
  });

  it('missing or malformed link: explains and offers a new one', async () => {
    window.history.replaceState(null, '', '/reset-password');
    render(<ResetPasswordPage />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/invalid or incomplete/);
    expect(screen.getByRole('link', { name: 'Request a new link' }).getAttribute('href')).toBe(
      '/forgot-password',
    );
  });

  it('validates locally, then sets the password and shows the signed-out success state', async () => {
    window.history.replaceState(null, '', `/reset-password#token=${TOKEN}`);
    confirmPasswordReset.mockResolvedValue({ ok: true });
    render(<ResetPasswordPage />);
    fireEvent.change(await screen.findByLabelText('New password'), {
      target: { value: 'new-password-1' },
    });
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'different-1' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Set new password' }));
    });
    expect(screen.getByRole('alert').textContent).toMatch(/do not match/);
    expect(confirmPasswordReset).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'new-password-1' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Set new password' }));
    });
    expect(confirmPasswordReset).toHaveBeenCalledWith({
      token: TOKEN,
      newPassword: 'new-password-1',
    });
    expect(screen.getByRole('status').textContent).toMatch(/signed out everywhere/);
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/login');
  });

  it('an invalid, expired or used link gets one generic message', async () => {
    window.history.replaceState(null, '', `/reset-password#token=${TOKEN}`);
    confirmPasswordReset.mockRejectedValue(
      new ApiError(
        'This reset link is invalid or has expired. Request a new one.',
        400,
        'PASSWORD_RESET_INVALID',
      ),
    );
    render(<ResetPasswordPage />);
    fireEvent.change(await screen.findByLabelText('New password'), {
      target: { value: 'new-password-1' },
    });
    fireEvent.change(screen.getByLabelText('Confirm new password'), {
      target: { value: 'new-password-1' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Set new password' }));
    });
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        'This reset link is invalid or has expired. Request a new one.',
      ),
    );
  });
});
