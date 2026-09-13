'use client';

import { useEffect } from 'react';

type Props = {
  error: Error & { digest?: string };
  reset: () => void;
};

/**
 * Next.js route error UI — no stack traces; reference for support.
 */
export default function AppError({ error, reset }: Props) {
  const referenceId =
    error.digest && error.digest.length > 0
      ? `req_${error.digest.slice(0, 24)}`
      : `req_${Date.now().toString(16)}`;

  useEffect(() => {
    void (async () => {
      try {
        const apiBase =
          process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, '') || 'http://localhost:3001';
        const token = window.localStorage.getItem('project-x.accessToken');
        if (!token) return;
        await fetch(`${apiBase}/api/telemetry/client-errors`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'X-Request-Id': referenceId,
          },
          body: JSON.stringify({
            client: 'dashboard',
            component: 'next_error',
            event: 'page_crash',
            errorCode: error.name || 'NextError',
            normalizedMessage: 'Next.js route error',
            requestId: referenceId,
            release: process.env.NEXT_PUBLIC_APP_RELEASE || undefined,
          }),
        });
      } catch {
        // ignore
      }
    })();
  }, [error.name, referenceId]);

  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="font-display text-xl font-semibold tracking-tight text-ink">
        Something went wrong
      </h1>
      <p className="max-w-md text-sm text-muted-foreground">
        Try again. If the problem continues, share the reference with support.
      </p>
      <p className="rounded-lg border border-line bg-panel/80 px-3 py-2 font-mono text-xs text-muted-foreground">
        Reference: {referenceId}
      </p>
      <button
        type="button"
        onClick={reset}
        className="rounded-xl bg-ink px-4 py-2 text-sm font-semibold text-inverse transition hover:opacity-90"
      >
        Try again
      </button>
    </div>
  );
}
