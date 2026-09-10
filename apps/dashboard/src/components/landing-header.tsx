'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { BrandMark } from './brand-mark';
import { ThemeToggle } from './theme-toggle';
import { getAccessToken, getStoredUser, type StoredAuthUser } from '../lib/auth-storage';

export function LandingHeader() {
  const [user, setUser] = useState<StoredAuthUser | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const token = getAccessToken();
    setUser(token ? getStoredUser() : null);
    setReady(true);
  }, []);

  const signedIn = ready && Boolean(user && getAccessToken());

  return (
    <header className="flex items-center justify-between rise-in">
      <BrandMark />
      <div className="flex items-center gap-2 sm:gap-3">
        <ThemeToggle compact />
        {signedIn ? (
          <>
            <span className="hidden max-w-[180px] truncate items-center gap-2 rounded-full border border-line bg-panel/70 px-3 py-1 text-[11px] font-medium text-muted-foreground sm:inline-flex">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
              {user?.email ?? 'Signed in'}
            </span>
            <Link
              href="/app"
              className="rounded-xl bg-ink px-3.5 py-2 text-sm font-semibold text-inverse transition hover:opacity-90"
            >
              Open studio
            </Link>
          </>
        ) : (
          <>
            <Link
              href="/login"
              className="rounded-xl px-3 py-2 text-sm font-semibold text-muted-foreground transition hover:text-ink"
            >
              Sign in
            </Link>
            <Link
              href="/login"
              className="rounded-xl bg-ink px-3.5 py-2 text-sm font-semibold text-inverse transition hover:opacity-90"
            >
              Open studio
            </Link>
          </>
        )}
      </div>
    </header>
  );
}
