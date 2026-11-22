'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import { AUTH_BUTTON_CLASS, AuthShell } from '../../components/auth-shell';
import { ApiError, confirmEmailVerification, logout } from '../../lib/api';
import { readResetTokenFromHash } from '../reset-password/reset-token';

type State =
  'checking' | 'verified' | 'expired' | 'invalid' | 'error' | 'sign_in' | 'wrong_account';

/**
 * F-05: while the visitor signs in, the link's token waits in sessionStorage — this tab only,
 * this origin only, gone when the tab closes. It is never put in a URL (the sign-in redirect
 * carries only `next=/verify-email`), so it stays out of history, logs and Referer headers.
 */
const PENDING_KEY = 'px.pendingEmailVerification';
const SIGN_IN_HREF = '/login?next=%2Fverify-email';

function readPending(): string | null {
  try {
    const value = window.sessionStorage.getItem(PENDING_KEY);
    return value && /^[A-Za-z0-9_-]{20,200}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

function writePending(token: string | null): void {
  try {
    if (token) window.sessionStorage.setItem(PENDING_KEY, token);
    else window.sessionStorage.removeItem(PENDING_KEY);
  } catch {
    // Storage unavailable (private window): the visitor can open the link again after sign-in.
  }
}

/**
 * Decision A: confirms an email address with the token from the link's fragment. The fragment
 * is removed from the address bar immediately.
 *
 * F-05: the link alone confirms nothing. The API accepts the token only from a session of the
 * account it was issued for, so a visitor who is signed out is sent to sign in first, and one
 * signed in to a different account is told so (and can switch) — an unsolicited link can no
 * longer verify an account that somebody else created with this address.
 */
export default function VerifyEmailPage() {
  const [state, setState] = useState<State>('checking');
  const [switching, setSwitching] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // single submission (React strict mode runs effects twice)
    started.current = true;
    const fromLink = readResetTokenFromHash(window.location.hash);
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
    const token = fromLink ?? readPending();
    if (!token) {
      setState('invalid');
      return;
    }
    confirmEmailVerification(token)
      .then(() => {
        writePending(null);
        setState('verified');
      })
      .catch((err: unknown) => {
        const code = err instanceof ApiError ? err.code : undefined;
        if (err instanceof ApiError && err.statusCode === 401) {
          writePending(token);
          setState('sign_in');
        } else if (code === 'EMAIL_VERIFICATION_WRONG_ACCOUNT') {
          writePending(token);
          setState('wrong_account');
        } else if (code === 'EMAIL_VERIFICATION_EXPIRED') {
          writePending(null);
          setState('expired');
        } else if (code === 'EMAIL_VERIFICATION_INVALID') {
          writePending(null);
          setState('invalid');
        } else {
          setState('error');
        }
      });
  }, []);

  async function switchAccount() {
    setSwitching(true);
    await logout();
    window.location.assign(SIGN_IN_HREF);
  }

  const messages: Record<Exclude<State, 'checking'>, string> = {
    verified:
      'Your email address is confirmed. You can now use free AI actions and accept workspace invitations.',
    expired: 'This verification link has expired. Sign in and request a new one.',
    invalid: 'This verification link is invalid or was already used.',
    error: 'We could not confirm your email right now. Try the link again in a moment.',
    sign_in:
      'Sign in to the account you created to finish confirming this email address. If you did not create an account, close this page — nothing has been confirmed.',
    wrong_account:
      'This link was sent for a different account than the one you are signed in to. Switch to that account to confirm its email address.',
  };

  return (
    <AuthShell eyebrow="Account" title="Confirm your email">
      {state === 'checking' ? (
        <p role="status" className="mt-8 text-center text-sm text-muted-foreground">
          Confirming your email…
        </p>
      ) : (
        <div className="mt-8 space-y-4">
          <p
            role={state === 'verified' ? 'status' : 'alert'}
            className="rounded-xl border border-line bg-panel/70 px-3 py-3 text-sm text-ink"
          >
            {messages[state]}
          </p>
          {state === 'wrong_account' ? (
            <button
              type="button"
              disabled={switching}
              onClick={() => void switchAccount()}
              className={`${AUTH_BUTTON_CLASS} block w-full text-center`}
            >
              {switching ? 'Signing out…' : 'Switch account'}
            </button>
          ) : (
            <Link
              href={state === 'verified' ? '/app' : state === 'sign_in' ? SIGN_IN_HREF : '/login'}
              className={`${AUTH_BUTTON_CLASS} block text-center`}
            >
              {state === 'verified'
                ? 'Continue'
                : state === 'sign_in'
                  ? 'Sign in to confirm'
                  : 'Sign in'}
            </Link>
          )}
        </div>
      )}
    </AuthShell>
  );
}
