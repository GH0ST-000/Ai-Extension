'use client';

import Link from 'next/link';
import { type FormEvent, useState } from 'react';

import { safeErrorMessage } from '@project-x/shared';

import { AUTH_BUTTON_CLASS, AUTH_INPUT_CLASS, AuthShell } from '../../components/auth-shell';
import { requestPasswordReset } from '../../lib/api';
import { FORGOT_PASSWORD_CONFIRMATION } from './messages';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      await requestPasswordReset(email.trim());
      setDone(true);
    } catch (err) {
      setError(safeErrorMessage(err, 'Could not send the request. Try again in a moment.'));
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthShell
      eyebrow="Account recovery"
      title="Forgot your password?"
      subtitle="Enter your account email and we will send you a link to set a new password."
    >
      {done ? (
        <div className="mt-8 space-y-4">
          <p
            role="status"
            className="rounded-xl border border-accent/30 bg-accent-soft/50 px-3 py-3 text-sm text-ink"
          >
            {FORGOT_PASSWORD_CONFIRMATION}
          </p>
        </div>
      ) : (
        <form className="mt-8 space-y-4" onSubmit={onSubmit} noValidate={false}>
          <div className="space-y-2">
            <label htmlFor="email" className="text-sm font-semibold text-ink">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              maxLength={255}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@company.com"
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
            {pending ? 'Sending…' : 'Send reset link'}
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
