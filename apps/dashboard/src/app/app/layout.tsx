'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { BrandMark } from '../../components/brand-mark';
import { DashboardNav } from '../../components/dashboard-nav';
import { AuthGate, useAuthUser } from '../../components/auth-gate';
import { ThemeToggle } from '../../components/theme-toggle';
import { clearSession } from '../../lib/auth-storage';

function DashboardShell({ children }: { children: ReactNode }) {
  const user = useAuthUser();
  const router = useRouter();

  function signOut() {
    clearSession();
    router.replace('/login');
  }

  return (
    <div className="atmosphere relative min-h-screen overflow-hidden text-ink">
      <div className="pointer-events-none absolute inset-0 grid-fade opacity-60" aria-hidden />
      <div
        className="pointer-events-none absolute -left-24 top-24 h-64 w-64 rounded-full bg-accent/15 blur-3xl float-soft"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute -right-16 bottom-10 h-72 w-72 rounded-full bg-spark/10 blur-3xl"
        aria-hidden
      />

      <div className="relative mx-auto flex min-h-screen max-w-7xl gap-0 px-0 md:px-4 md:py-4 lg:px-6">
        <aside className="panel-glass relative z-10 hidden w-[248px] shrink-0 flex-col rounded-none border-y-0 border-l-0 p-5 shadow-panel md:flex md:rounded-2xl md:border">
          <div className="mb-8">
            <BrandMark />
          </div>

          <DashboardNav />

          <div className="mt-auto space-y-3 pt-8">
            <div className="rounded-2xl bg-ink px-4 py-4 text-inverse">
              <p className="font-display text-sm font-semibold tracking-tight">Browser AI</p>
              <p className="mt-1 text-[12px] leading-relaxed text-inverse/70">
                Smart actions, PR reports, and confirmed GitHub reviews — from the selection.
              </p>
            </div>
            <p className="truncate px-1 text-[11px] text-muted-foreground">
              {user?.email ?? 'Signed in'}
            </p>
          </div>
        </aside>

        <div className="relative z-10 flex min-w-0 flex-1 flex-col md:pl-4">
          <header className="panel-glass flex h-14 items-center justify-between rounded-none border-x-0 border-t-0 px-5 shadow-panel md:rounded-2xl md:border">
            <div className="md:hidden">
              <BrandMark showWordmark={false} />
            </div>
            <div className="hidden md:block">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                Workspace
              </p>
              <p className="font-display text-sm font-semibold tracking-tight">Personal studio</p>
            </div>
            <div className="flex items-center gap-3">
              <ThemeToggle compact />
              <span className="hidden max-w-[160px] truncate items-center gap-2 rounded-full border border-line bg-panel/70 px-3 py-1 text-[11px] font-medium text-muted-foreground lg:inline-flex">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                {user?.email ?? 'Account'}
              </span>
              <button
                type="button"
                onClick={signOut}
                className="rounded-xl bg-ink px-3.5 py-2 text-sm font-semibold text-inverse transition hover:opacity-90"
              >
                Sign out
              </button>
            </div>
          </header>

          <div className="mt-0 flex gap-2 overflow-x-auto px-4 py-3 md:hidden">
            <Link
              href="/app"
              className="shrink-0 rounded-full border border-line bg-panel/80 px-3 py-1.5 text-xs font-semibold"
            >
              Overview
            </Link>
            <Link
              href="/app/memory"
              className="shrink-0 rounded-full border border-line bg-panel/80 px-3 py-1.5 text-xs font-semibold"
            >
              Memory
            </Link>
            <Link
              href="/app/systems"
              className="shrink-0 rounded-full border border-line bg-panel/80 px-3 py-1.5 text-xs font-semibold"
            >
              Systems
            </Link>
            <Link
              href="/app/reliability"
              className="shrink-0 rounded-full border border-line bg-panel/80 px-3 py-1.5 text-xs font-semibold"
            >
              Reliability
            </Link>
            <Link
              href="/app/settings"
              className="shrink-0 rounded-full border border-line bg-panel/80 px-3 py-1.5 text-xs font-semibold"
            >
              Settings
            </Link>
          </div>

          <main className="flex-1 px-4 py-6 md:px-1 md:py-6">{children}</main>
        </div>
      </div>
    </div>
  );
}

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <AuthGate>
      <DashboardShell>{children}</DashboardShell>
    </AuthGate>
  );
}
