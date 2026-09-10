'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { getAccessToken, getStoredUser } from '../lib/auth-storage';

export function LandingHeroCtas() {
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    const token = getAccessToken();
    setSignedIn(Boolean(token && getStoredUser()));
  }, []);

  if (signedIn) {
    return (
      <div className="mt-7 flex flex-wrap gap-3">
        <Link
          href="/app"
          className="rounded-2xl bg-accent px-5 py-2.5 text-sm font-semibold text-accent-foreground shadow-soft transition hover:brightness-110"
        >
          Open studio
        </Link>
        <Link
          href="/app/settings"
          className="rounded-2xl border border-line bg-panel/75 px-5 py-2.5 text-sm font-semibold text-ink transition hover:bg-panel"
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
        className="rounded-2xl bg-accent px-5 py-2.5 text-sm font-semibold text-accent-foreground shadow-soft transition hover:brightness-110"
      >
        Sign in
      </Link>
      <Link
        href="/login"
        className="rounded-2xl border border-line bg-panel/75 px-5 py-2.5 text-sm font-semibold text-ink transition hover:bg-panel"
      >
        Create account
      </Link>
    </div>
  );
}
