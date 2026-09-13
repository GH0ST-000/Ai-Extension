'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import type { OnboardingView } from '@project-x/types';

import { ApiError, dismissOnboarding, fetchOnboarding, markWelcomeSeen } from '../lib/api';

const STEP_LABELS = [
  { key: 'accountReady', label: 'Account ready' },
  { key: 'workspaceReady', label: 'Workspace ready' },
  { key: 'githubConnected', label: 'Connect GitHub' },
  { key: 'firstActionCompleted', label: 'Complete a useful AI action' },
] as const;

function ctaPath(view: OnboardingView): string {
  switch (view.nextStep) {
    case 'connect_github':
      return '/app/settings';
    case 'workspace':
      return '/app/workspace';
    case 'try_project_x':
      return view.steps.githubConnected ? '/app/settings' : '/app';
    default:
      return '/app/settings';
  }
}

export function OnboardingChecklist() {
  const [view, setView] = useState<OnboardingView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const next = await fetchOnboarding();
        if (!cancelled) {
          setView(next);
          if (!next.preferences.welcomeSeen) {
            void markWelcomeSeen()
              .then(setView)
              .catch(() => undefined);
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : null);
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (error || !view) {
    return null;
  }

  if (view.status === 'completed' || view.status === 'dismissed') {
    return null;
  }

  async function onDismiss() {
    setBusy(true);
    try {
      setView(await dismissOnboarding());
    } catch {
      // ignore
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-label="Getting started"
      className="rise-in rounded-3xl border border-accent/30 bg-accent-soft/40 p-6 shadow-panel md:p-7"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-accent">
            Get started
          </p>
          <h2 className="mt-2 font-display text-2xl font-semibold tracking-tight text-ink">
            {view.recommendedAction?.title ?? 'Finish setup'}
          </h2>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">
            {view.recommendedAction?.body ?? 'A few steps to reach your first useful result.'}
          </p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void onDismiss()}
          className="text-sm font-semibold text-muted-foreground underline-offset-4 hover:underline"
        >
          Dismiss
        </button>
      </div>

      <ul className="mt-5 grid gap-2 sm:grid-cols-2">
        {STEP_LABELS.map((step) => {
          const done = view.steps[step.key];
          const current =
            (step.key === 'githubConnected' && view.nextStep === 'connect_github') ||
            (step.key === 'firstActionCompleted' && view.nextStep === 'try_project_x');
          return (
            <li
              key={step.key}
              className={[
                'flex items-center gap-2 rounded-xl border px-3 py-2 text-sm',
                done
                  ? 'border-line/60 bg-panel/70 text-muted-foreground'
                  : current
                    ? 'border-accent/40 bg-panel text-ink'
                    : 'border-line/60 bg-panel/40 text-ink',
              ].join(' ')}
            >
              <span aria-hidden className="font-mono text-xs">
                {done ? '✓' : '○'}
              </span>
              <span className={done ? 'line-through' : 'font-medium'}>{step.label}</span>
            </li>
          );
        })}
      </ul>

      <div className="mt-5 flex flex-wrap gap-3">
        <Link
          href={ctaPath(view)}
          className="rounded-xl bg-ink px-4 py-2.5 text-sm font-semibold text-inverse transition hover:opacity-90"
        >
          {view.recommendedAction?.ctaLabel ?? 'Continue'}
        </Link>
        <Link
          href="/app/settings"
          className="rounded-xl border border-line px-4 py-2.5 text-sm font-semibold text-ink transition hover:bg-mist"
        >
          Connections
        </Link>
      </div>
      <p className="mt-4 text-xs text-muted-foreground">
        Project X never posts comments, submits reviews, or applies code changes without your
        explicit confirmation.
      </p>
    </section>
  );
}
