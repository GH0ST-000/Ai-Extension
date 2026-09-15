'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { APP_NAME } from '@project-x/shared';

import { BrandMark } from '../../../components/brand-mark';
import { ThemeToggle } from '../../../components/theme-toggle';
import { ApiError } from '../../../lib/api';
import { getStoredUser } from '../../../lib/auth-storage';
import { acceptInvitation } from '../../../lib/workspace-api';

const WORKSPACE_STORAGE_KEY = 'project-x.dashboard.workspaceId';

function apiMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

function persistAcceptedWorkspaceId(workspaceId: string): void {
  try {
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, workspaceId);
  } catch {
    // ignore quota / private mode
  }
}

export default function AcceptInvitePage() {
  const router = useRouter();
  const params = useParams<{ token: string }>();
  const token = typeof params.token === 'string' ? params.token.trim() : '';

  const [status, setStatus] = useState<'checking' | 'accepting' | 'success' | 'error'>('checking');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!token) {
        setStatus('error');
        setError('Invitation link is missing a token.');
        return;
      }

      if (!getStoredUser()) {
        const next = `/invite/${encodeURIComponent(token)}`;
        router.replace(`/login?next=${encodeURIComponent(next)}`);
        return;
      }

      setStatus('accepting');
      setError(null);
      try {
        const membership = await acceptInvitation(token);
        if (cancelled) {
          return;
        }
        persistAcceptedWorkspaceId(membership.workspaceId);
        setStatus('success');
        router.replace('/app/workspace/members');
      } catch (err) {
        if (!cancelled) {
          setStatus('error');
          setError(apiMessage(err, 'Unable to accept this invitation.'));
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [token, router]);

  return (
    <main className="atmosphere relative flex min-h-screen items-center justify-center overflow-hidden px-6 py-12">
      <div className="pointer-events-none absolute inset-0 grid-fade opacity-40" aria-hidden />
      <div
        className="pointer-events-none absolute left-[10%] top-[15%] h-72 w-72 rounded-full bg-accent/25 blur-3xl float-soft"
        aria-hidden
      />

      <div className="absolute right-6 top-6 z-10">
        <ThemeToggle compact />
      </div>

      <div className="relative w-full max-w-md rise-in">
        <div className="mb-8 flex justify-center">
          <BrandMark size="lg" />
        </div>

        <div className="panel-glass rounded-3xl p-7 shadow-panel md:p-8">
          <p className="text-center text-[11px] font-semibold uppercase tracking-[0.2em] text-accent">
            Workspace invite
          </p>
          <h1 className="mt-3 text-center font-display text-3xl font-semibold tracking-tight text-ink">
            {status === 'success'
              ? 'You are in'
              : status === 'error'
                ? 'Invite unavailable'
                : `Join ${APP_NAME}`}
          </h1>
          <p className="mt-2 text-center text-sm text-muted-foreground">
            {status === 'checking' || status === 'accepting'
              ? 'Accepting your invitation…'
              : status === 'success'
                ? 'Redirecting to your workspace members.'
                : (error ?? 'This invitation could not be accepted.')}
          </p>

          {status === 'error' ? (
            <div className="mt-8 flex flex-col items-center gap-3">
              <Link
                href="/app"
                className="rounded-xl bg-ink px-4 py-2.5 text-sm font-semibold text-inverse transition hover:opacity-90"
              >
                Open dashboard
              </Link>
              <Link
                href="/login"
                className="text-sm font-semibold text-muted-foreground transition hover:text-ink"
              >
                Sign in with another account
              </Link>
            </div>
          ) : null}
        </div>
      </div>
    </main>
  );
}
