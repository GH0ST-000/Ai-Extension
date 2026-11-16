'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import type { OnboardingView } from '@project-x/types';

import { ApiError, dismissOnboarding, fetchOnboarding, markWelcomeSeen } from '../lib/api';
import { getExtensionInstallUrl } from '../lib/extension-install';

/** The first-review journey. GitHub access is not required for a basic review. */
export const FIRST_REVIEW_STEPS = [
  {
    title: 'Install the Project X browser extension',
    detail: 'Sign in with this account — the extension and dashboard share it.',
  },
  {
    title: 'Open a pull request on github.com',
    detail: 'Any PR you can see in your browser.',
  },
  {
    title: 'Choose Review Entire PR',
    detail: 'From the Project X menu on the PR page. Findings come with severity and evidence.',
  },
] as const;

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

  // PR-review onboarding: stays until the server has a successful PR review from this user,
  // or the user dismisses it. Other first actions (e.g. Ask AI) do not hide it.
  if (view.status === 'dismissed' || view.firstPrReviewCompleted === true) {
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

  const installUrl = getExtensionInstallUrl();
  const githubConnected = view.steps.githubConnected;

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
            Run your first AI PR review
          </h2>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">
            Three steps from here to review findings on a real pull request.
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

      <ol className="mt-5 grid gap-2 md:grid-cols-3" aria-label="First review steps">
        {FIRST_REVIEW_STEPS.map((step, index) => (
          <li
            key={step.title}
            className="flex gap-3 rounded-xl border border-line/60 bg-panel/70 px-3 py-3 text-sm"
          >
            <span
              aria-hidden
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-accent/15 font-display text-xs font-bold text-accent"
            >
              {index + 1}
            </span>
            <span className="min-w-0">
              <span className="block font-semibold text-ink">{step.title}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">{step.detail}</span>
            </span>
          </li>
        ))}
      </ol>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        {installUrl ? (
          <a
            href={installUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-xl bg-ink px-4 py-2.5 text-sm font-semibold text-inverse transition hover:opacity-90"
          >
            Install the extension
          </a>
        ) : (
          <p className="text-sm text-muted-foreground" data-testid="extension-install-fallback">
            The extension is available to Private Beta users — ask your Project X contact for the
            install link.
          </p>
        )}
      </div>

      <div
        className="mt-4 rounded-xl border border-line/60 bg-panel/60 px-3 py-2.5 text-sm"
        data-testid="review-coverage-note"
      >
        {githubConnected ? (
          <p className="text-ink">
            <span aria-hidden>✓ </span>
            GitHub is connected — reviews use the full pull request diff.
          </p>
        ) : (
          <p className="text-muted-foreground">
            <span className="font-semibold text-ink">No GitHub connection needed to start.</span> A
            basic review reads the diff shown on the PR page. For full coverage of every changed
            file,{' '}
            <Link
              href="/app/settings"
              className="font-semibold text-accent underline-offset-4 hover:underline"
            >
              connect GitHub
            </Link>
            .
          </p>
        )}
      </div>

      <p className="mt-4 text-xs text-muted-foreground">
        Project X never posts comments, submits reviews, or applies code changes without your
        explicit confirmation.
      </p>
    </section>
  );
}
