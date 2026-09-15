'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { getStoredUser } from '../lib/auth-storage';

export function LandingHeroCtas() {
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    setSignedIn(Boolean(getStoredUser()));
  }, []);

  if (signedIn) {
    return (
      <div className="mt-7 flex flex-wrap gap-3">
        <Link
          href="/app"
          className="rounded-2xl bg-accent px-5 py-2.5 text-sm font-semibold text-accent-foreground shadow-soft transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          Open Studio
        </Link>
        <Link
          href="/app/settings"
          className="rounded-2xl border border-line bg-panel/75 px-5 py-2.5 text-sm font-semibold text-ink transition hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          Settings
        </Link>
      </div>
    );
  }

  return (
    <div className="mt-7 flex flex-wrap gap-3">
      <Link
        href="/login"
        className="rounded-2xl bg-accent px-5 py-2.5 text-sm font-semibold text-accent-foreground shadow-soft transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
      >
        Get Started
      </Link>
      <Link
        href="/login"
        className="rounded-2xl border border-line bg-panel/75 px-5 py-2.5 text-sm font-semibold text-ink transition hover:bg-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        Sign in
      </Link>
    </div>
  );
}
