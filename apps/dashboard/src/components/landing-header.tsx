'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { BrandMark } from './brand-mark';
import { ThemeToggle } from './theme-toggle';
import { getStoredUser, type StoredAuthUser } from '../lib/auth-storage';

export function LandingHeader() {
  const [user, setUser] = useState<StoredAuthUser | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setUser(getStoredUser());
    setReady(true);
  }, []);

  const signedIn = ready && Boolean(user);

  return (
    <header className="fixed inset-x-0 top-0 z-50 border-b border-line/60 bg-mist/85 backdrop-blur-xl supports-[backdrop-filter]:bg-mist/70">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-2 px-6 md:h-[3.75rem] md:px-10">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <div className="sm:hidden">
            <BrandMark showWordmark={false} />
          </div>
          <div className="hidden sm:block">
            <BrandMark />
          </div>
          <span className="hidden rounded-full border border-line bg-panel/70 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground md:inline-flex">
            Private Beta
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 sm:gap-3">
          <ThemeToggle compact />
          {signedIn ? (
            <>
              <span className="hidden max-w-[180px] truncate items-center gap-2 rounded-full border border-line bg-panel/70 px-3 py-1 text-[11px] font-medium text-muted-foreground lg:inline-flex">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                {user?.email ?? 'Signed in'}
              </span>
              <Link
                href="/app"
                className="rounded-xl bg-ink px-3 py-2 text-xs font-semibold text-inverse transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 sm:px-3.5 sm:text-sm"
              >
                Open Studio
              </Link>
            </>
          ) : (
            <>
              <Link
                href="/login"
                className="hidden rounded-xl px-3 py-2 text-sm font-semibold text-muted-foreground transition hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:inline-flex"
              >
                Sign in
              </Link>
              <Link
                href="/login"
                className="rounded-xl bg-ink px-3 py-2 text-xs font-semibold text-inverse transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 sm:px-3.5 sm:text-sm"
              >
                Get Started
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
