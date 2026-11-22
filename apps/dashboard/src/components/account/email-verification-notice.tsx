'use client';

import { useEffect, useState } from 'react';

import {
  type EmailVerificationResendStatus,
  getEmailVerificationStatus,
  resendEmailVerification,
} from '../../lib/api';

const RESEND_MESSAGES: Record<EmailVerificationResendStatus, string> = {
  sent: 'We sent a new verification link. It expires in 24 hours.',
  already_verified: 'Your email address is already verified.',
  throttled: 'A link was sent recently. Check your inbox, or try again in a few minutes.',
  mail_not_configured: 'Email delivery is not available right now. Please contact support.',
  mail_failed: 'We could not send the email. Try again in a few minutes.',
};

/**
 * Decision A / Decision 1: shown while the signed-in user's email is unverified. Verification
 * is required to accept workspace invitations and to use free-plan AI actions (paid workspaces
 * are unaffected); everything else keeps working. Renders nothing otherwise.
 * `force` shows it without waiting for the status (e.g. after an EMAIL_NOT_VERIFIED error).
 */
export function EmailVerificationNotice({ force = false }: { force?: boolean }) {
  const [state, setState] = useState<{ email: string; verified: boolean } | null>(null);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getEmailVerificationStatus()
      .then((s) => !cancelled && setState(s))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  if (state?.verified) return null;
  if (!state && !force) return null;

  async function resend() {
    if (sending) return;
    setSending(true);
    try {
      const { status } = await resendEmailVerification();
      setMessage(RESEND_MESSAGES[status]);
    } catch {
      setMessage(RESEND_MESSAGES.mail_failed);
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      role="status"
      className="flex flex-col gap-2 rounded-xl border border-accent/30 bg-accent-soft/50 px-3 py-3 text-sm text-ink sm:flex-row sm:items-center sm:justify-between"
    >
      <p>
        Confirm your email address{state ? ` (${state.email})` : ''} to use free AI actions and
        accept workspace invitations. Check your inbox for the verification link.
        {message ? <span className="mt-1 block text-muted-foreground">{message}</span> : null}
      </p>
      <button
        type="button"
        onClick={() => void resend()}
        disabled={sending}
        className="shrink-0 rounded-lg border border-line px-2.5 py-1.5 text-xs font-semibold text-ink disabled:opacity-50"
      >
        {sending ? 'Sending…' : 'Resend link'}
      </button>
    </div>
  );
}
