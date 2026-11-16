'use client';

import Link from 'next/link';
import { type FormEvent, useEffect, useState } from 'react';

import { safeErrorMessage } from '@project-x/shared';

import { AUTH_BUTTON_CLASS, AUTH_INPUT_CLASS, AuthShell } from '../../components/auth-shell';
import { ApiError, confirmPasswordReset } from '../../lib/api';
import { PASSWORD_MAX, PASSWORD_MIN, passwordProblem, readResetTokenFromHash } from './reset-token';

export default function ResetPasswordPage() {
  const [token, setToken] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fromHash = readResetTokenFromHash(window.location.hash);
    setToken(fromHash);
    setChecked(true);
    if (window.location.hash) {
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    const problem = passwordProblem(password, confirmation);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setPending(true);
    try {
      await confirmPasswordReset({ token, newPassword: password });
      setDone(true);
      setToken(null);
      setPassword('');
      setConfirmation('');
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'PASSWORD_RESET_INVALID'
          ? 'This reset link is invalid or has expired. Request a new one.'
          : safeErrorMessage(err, 'Could not reset the password. Try again in a moment.'),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthShell eyebrow="Account recovery" title="Set a new password">
      {!checked ? (
        <p role="status" className="mt-8 text-center text-sm text-muted-foreground">
          Checking your link…
        </p>
      ) : done ? (
        <div className="mt-8 space-y-4">
          <p
            role="status"
            className="rounded-xl border border-accent/30 bg-accent-soft/50 px-3 py-3 text-sm text-ink"
          >
            Your password was changed. For your security you were signed out everywhere — sign in
            with the new password.
          </p>
          <Link href="/login" className={`${AUTH_BUTTON_CLASS} block text-center`}>
            Sign in
          </Link>
        </div>
      ) : !token ? (
        <div className="mt-8 space-y-4">
          <p
            role="alert"
            className="rounded-xl border border-line bg-panel/70 px-3 py-3 text-sm text-ink"
          >
            This reset link is invalid or incomplete. Request a new one.
          </p>
          <Link href="/forgot-password" className={`${AUTH_BUTTON_CLASS} block text-center`}>
            Request a new link
          </Link>
        </div>
      ) : (
        <form className="mt-8 space-y-4" onSubmit={onSubmit}>
          <div className="space-y-2">
            <label htmlFor="new-password" className="text-sm font-semibold text-ink">
              New password
            </label>
            <input
              id="new-password"
              name="new-password"
              type="password"
              autoComplete="new-password"
              required
              minLength={PASSWORD_MIN}
              maxLength={PASSWORD_MAX}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={`At least ${PASSWORD_MIN} characters`}
              className={AUTH_INPUT_CLASS}
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="confirm-password" className="text-sm font-semibold text-ink">
              Confirm new password
            </label>
            <input
              id="confirm-password"
              name="confirm-password"
              type="password"
              autoComplete="new-password"
              required
              minLength={PASSWORD_MIN}
              maxLength={PASSWORD_MAX}
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              className={AUTH_INPUT_CLASS}
            />
          </div>
          {error ? (
            <p
              role="alert"
              className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300"
            >
              {error}
            </p>
          ) : null}
          <button type="submit" disabled={pending} className={AUTH_BUTTON_CLASS}>
            {pending ? 'Saving…' : 'Set new password'}
          </button>
        </form>
      )}
      <p className="mt-6 text-center text-sm text-muted-foreground">
        <Link
          href="/login"
          className="font-semibold text-accent underline-offset-4 hover:underline"
        >
          Back to sign in
        </Link>
      </p>
    </AuthShell>
  );
}
