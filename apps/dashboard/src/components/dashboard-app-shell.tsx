'use client';

import type { ReactNode } from 'react';
import { useRouter } from 'next/navigation';

import { BrandMark } from './brand-mark';
import { DashboardErrorBoundary } from './dashboard-error-boundary';
import { DashboardMobileNav } from './dashboard-mobile-nav';
import { DashboardNav } from './dashboard-nav';
import { AuthGate, useAuthUser } from './auth-gate';
import { ThemeToggle } from './theme-toggle';
import { WorkspaceSwitcher } from './workspace-switcher';
import { logout } from '../lib/api';
import { useWorkspace, WorkspaceProvider } from '../lib/workspace-context';

function DashboardShell({ children }: { children: ReactNode }) {
  const user = useAuthUser();
  const router = useRouter();
  const { currentWorkspaceId, workspaceRevision, error: workspaceError } = useWorkspace();

  async function signOut() {
    await logout();
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
          <header className="panel-glass relative z-30 flex h-14 items-center justify-between gap-2 overflow-visible rounded-none border-x-0 border-t-0 px-3 shadow-panel sm:gap-3 sm:px-5 md:rounded-2xl md:border">
            <div className="flex min-w-0 items-center gap-2">
              <div className="shrink-0 md:hidden">
                <BrandMark showWordmark={false} />
              </div>
              <div className="hidden md:block">
                <WorkspaceSwitcher />
              </div>
              <div className="min-w-0 md:hidden">
                <WorkspaceSwitcher compact />
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5 sm:gap-3">
              <ThemeToggle compact />
              <span className="hidden max-w-[160px] truncate items-center gap-2 rounded-full border border-line bg-panel/70 px-3 py-1 text-[11px] font-medium text-muted-foreground lg:inline-flex">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                {user?.email ?? 'Account'}
              </span>
              <button
                type="button"
                onClick={signOut}
                className="rounded-xl bg-ink px-2.5 py-2 text-xs font-semibold text-inverse transition hover:opacity-90 sm:px-3.5 sm:text-sm"
              >
                Sign out
              </button>
            </div>
          </header>

          {workspaceError ? (
            <div className="mx-4 mt-4 rounded-xl border border-line bg-panel px-3 py-2 text-sm text-red-600 dark:text-red-400 md:mx-1">
              {workspaceError}
            </div>
          ) : null}

          <main
            key={`${currentWorkspaceId ?? 'none'}-${workspaceRevision}`}
            className="relative z-0 flex-1 px-4 py-6 pb-[calc(5.5rem+env(safe-area-inset-bottom))] md:px-1 md:py-6 md:pb-6"
          >
            <DashboardErrorBoundary>{children}</DashboardErrorBoundary>
          </main>
        </div>
      </div>

      <DashboardMobileNav />
    </div>
  );
}

export function DashboardAppShell({ children }: { children: ReactNode }) {
  return (
    <AuthGate>
      <WorkspaceProvider>
        <DashboardShell>{children}</DashboardShell>
      </WorkspaceProvider>
    </AuthGate>
  );
}
