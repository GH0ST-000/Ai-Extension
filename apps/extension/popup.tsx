import { useEffect, useState, type FormEvent, type ReactNode } from 'react';

import {
  APP_NAME,
  formatGitHubConnectionLabel,
  GITHUB_WRITE_CONFIRMATION_NOTE,
  GITHUB_WHY_CONNECT,
} from '@project-x/shared';
import type { AuthUser, GitHubConnectionStatus, OnboardingView } from '@project-x/types';

import {
  dismissOnboarding,
  fetchOnboarding,
  markWelcomeSeen,
} from './lib/onboarding/onboarding-api';
import { AuthClientError, login, register, signOut } from './lib/services/auth-client';
import { getStoredSessionFast } from './lib/services/auth-storage';
import { getGithubConnection } from './lib/services/github-api';
import { getDashboardAppUrl, getDashboardBillingUrl } from './lib/workspace/dashboard-url';
import { useWorkspaceStore } from './lib/workspace/workspace.store';
import { WorkspaceSwitcher } from './lib/workspace/workspace-switcher';

import './style.css';

type Mode = 'login' | 'register';

function BrandGlyph({ size = 36 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 128 128"
      aria-hidden
      className="shrink-0 rounded-[0.85rem] shadow-sm"
    >
      <defs>
        <linearGradient
          id="pxPlatePopup"
          x1="20"
          y1="8"
          x2="108"
          y2="120"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0%" stopColor="#141C2E" />
          <stop offset="100%" stopColor="#0B1220" />
        </linearGradient>
      </defs>
      <rect width="128" height="128" rx="36" fill="url(#pxPlatePopup)" />
      <rect
        x="3"
        y="3"
        width="122"
        height="122"
        rx="33"
        fill="none"
        stroke="#14B8A6"
        strokeOpacity="0.35"
        strokeWidth="3"
      />
      <g fill="none" stroke="#14B8A6" strokeWidth="14" strokeLinecap="round">
        <path d="M36 36 L92 92" />
        <path d="M92 36 L36 92" />
      </g>
      <circle cx="92" cy="36" r="8" fill="#F59E0B" />
      <circle cx="92" cy="36" r="3" fill="#FFF7ED" fillOpacity="0.92" />
    </svg>
  );
}

function BrandHeader({ badge }: { badge?: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <BrandGlyph />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[14px] font-semibold tracking-tight text-[var(--px-text-primary)]">
          {APP_NAME}
        </p>
        <p className="mt-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--px-text-muted)]">
          Extension
        </p>
      </div>
      {badge ? (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--px-border)] bg-[var(--px-accent-soft)] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--px-accent)]">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--px-accent)]" aria-hidden />
          {badge}
        </span>
      ) : null}
    </div>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="relative w-[340px] overflow-hidden bg-[var(--px-bg)] text-[var(--px-text-primary)]">
      <div
        className="pointer-events-none absolute inset-0 opacity-90"
        style={{ backgroundImage: 'var(--px-wash)' }}
        aria-hidden
      />
      <div className="relative space-y-4 p-4">{children}</div>
    </div>
  );
}

function NavLink({
  href,
  children,
  external = true,
}: {
  href: string;
  children: ReactNode;
  external?: boolean;
}) {
  return (
    <a
      href={href}
      target={external ? '_blank' : undefined}
      rel={external ? 'noreferrer' : undefined}
      className="group flex items-center justify-between gap-3 rounded-2xl border border-[var(--px-border)] bg-[var(--px-surface)] px-3.5 py-3 text-[12.5px] font-semibold text-[var(--px-text-primary)] transition hover:border-[var(--px-accent)]/35 hover:bg-[var(--px-hover)]"
    >
      <span>{children}</span>
      <span
        aria-hidden
        className="text-[var(--px-text-muted)] transition group-hover:translate-x-0.5 group-hover:text-[var(--px-accent)]"
      >
        →
      </span>
    </a>
  );
}

function StatusPill({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  tone?: 'neutral' | 'good' | 'warn';
}) {
  const toneClass =
    tone === 'good'
      ? 'text-[var(--px-accent)]'
      : tone === 'warn'
        ? 'text-[var(--px-amber)]'
        : 'text-[var(--px-text-primary)]';

  return (
    <div className="min-w-0 rounded-2xl border border-[var(--px-border)] bg-[var(--px-surface)] px-3 py-2.5">
      <p className="text-[9px] font-semibold uppercase tracking-[0.14em] text-[var(--px-text-muted)]">
        {label}
      </p>
      <p className={`mt-1 truncate text-[12px] font-semibold tracking-tight ${toneClass}`}>
        {value}
      </p>
    </div>
  );
}

function IndexPopup() {
  const [mode, setMode] = useState<Mode>('login');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [github, setGithub] = useState<GitHubConnectionStatus | null>(null);
  const [onboarding, setOnboarding] = useState<OnboardingView | null>(null);
  const [showWelcome, setShowWelcome] = useState(false);

  const workspace = useWorkspaceStore((state) => state.current);
  const workspaceLoading = useWorkspaceStore((state) => state.loading);
  const currentWorkspaceId = useWorkspaceStore((state) => state.currentWorkspaceId);

  useEffect(() => {
    let cancelled = false;

    function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
      return new Promise((resolve) => {
        const timer = window.setTimeout(() => resolve(undefined), ms);
        promise.then(
          (value) => {
            window.clearTimeout(timer);
            resolve(value);
          },
          () => {
            window.clearTimeout(timer);
            resolve(undefined);
          },
        );
      });
    }

    async function loadSecondary() {
      void useWorkspaceStore.getState().bootstrap();
      const extras = await withTimeout(
        Promise.all([
          getGithubConnection().catch(() => ({ connected: false }) as GitHubConnectionStatus),
          fetchOnboarding().catch(() => null),
        ]),
        4_000,
      );
      if (cancelled || !extras) return;
      const [githubStatus, onboardingView] = extras;
      setGithub(githubStatus);
      setOnboarding(onboardingView);
      if (
        onboardingView &&
        (onboardingView.status === 'not_started' ||
          (!onboardingView.preferences.welcomeSeen && !onboardingView.steps.firstActionCompleted))
      ) {
        setShowWelcome(true);
      }
    }

    async function load() {
      // Paint immediately from local storage — never block the popup on network/cookies.
      try {
        const local = await getStoredSessionFast();
        if (cancelled) return;
        if (local?.user) {
          setUser(local.user);
          setShowWelcome(false);
        } else {
          setUser(null);
          setShowWelcome(true);
        }
      } catch {
        if (!cancelled) {
          setUser(null);
          setShowWelcome(true);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }

      // Best-effort sync from dashboard cookies / handoff.
      type SyncResult = { signedIn?: boolean; user?: AuthUser | null };
      const synced = await withTimeout(
        chrome.runtime.sendMessage({ type: 'SYNC_SESSION' }) as Promise<SyncResult>,
        3_000,
      );
      if (cancelled) return;

      if (synced?.signedIn && synced.user) {
        setUser(synced.user);
        setShowWelcome(false);
        void loadSecondary();
        return;
      }

      const localAfter = await getStoredSessionFast().catch(() => null);
      if (cancelled) return;
      if (localAfter?.user) {
        setUser(localAfter.user);
        setShowWelcome(false);
        void loadSecondary();
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);

    try {
      const result =
        mode === 'register'
          ? await register({
              email,
              password,
              name: name.trim() || undefined,
            })
          : await login({ email, password });
      setUser(result.user);
      setPassword('');
      setShowWelcome(false);
      setLoading(false);
      void useWorkspaceStore.getState().bootstrap();
      const [githubStatus, onboardingView] = await Promise.all([
        getGithubConnection().catch(() => ({ connected: false }) as GitHubConnectionStatus),
        fetchOnboarding().catch(() => null),
      ]);
      setGithub(githubStatus);
      setOnboarding(onboardingView);
      await markWelcomeSeen().catch(() => undefined);
    } catch (err) {
      setError(err instanceof AuthClientError ? err.message : 'Unable to authenticate.');
    } finally {
      setPending(false);
    }
  }

  async function onSignOut() {
    await signOut();
    await useWorkspaceStore.getState().clear();
    setUser(null);
    setGithub(null);
    setOnboarding(null);
    setShowWelcome(true);
  }

  async function onGetStarted() {
    setShowWelcome(false);
    await markWelcomeSeen();
    if (onboarding) {
      setOnboarding({
        ...onboarding,
        preferences: { ...onboarding.preferences, welcomeSeen: true },
        status: onboarding.status === 'not_started' ? 'in_progress' : onboarding.status,
      });
    }
  }

  async function onDismissSetup() {
    await dismissOnboarding();
    setOnboarding((prev) =>
      prev
        ? {
            ...prev,
            status: 'dismissed',
            nextStep: null,
            recommendedAction: null,
            preferences: {
              ...prev.preferences,
              dismissedAt: new Date().toISOString(),
            },
          }
        : prev,
    );
  }

  if (loading) {
    return (
      <Shell>
        <BrandHeader />
        <p className="text-[13px] text-[var(--px-text-muted)]">Loading…</p>
      </Shell>
    );
  }

  if (!user && showWelcome) {
    return (
      <Shell>
        <BrandHeader badge="Beta" />
        <div className="space-y-2">
          <h1 className="text-[20px] font-semibold leading-tight tracking-tight text-[var(--px-text-primary)]">
            Understand and act where you work
          </h1>
          <p className="text-[13px] leading-relaxed text-[var(--px-text-secondary)]">
            Select text on any page for quick AI actions, or connect GitHub for PR reviews, CI
            analysis, and confirmed writes.
          </p>
          <p className="text-[12px] leading-relaxed text-[var(--px-text-muted)]">
            {GITHUB_WRITE_CONFIRMATION_NOTE}
          </p>
        </div>
        <button
          type="button"
          className="w-full rounded-full bg-[var(--px-accent)] px-3 py-2.5 text-[13px] font-semibold text-[#042f2e] transition hover:brightness-110"
          onClick={onGetStarted}
        >
          Get Started
        </button>
        <button
          type="button"
          className="w-full text-left text-[12px] font-semibold text-[var(--px-accent)] hover:underline"
          onClick={() => {
            setShowWelcome(false);
          }}
        >
          Try with selected text after sign-in
        </button>
      </Shell>
    );
  }

  if (user) {
    const planLabel = workspace?.plan.id
      ? workspace.plan.name ||
        workspace.plan.id.charAt(0).toUpperCase() + workspace.plan.id.slice(1)
      : workspaceLoading
        ? '…'
        : 'Free';
    const githubLabel = formatGitHubConnectionLabel({
      connected: Boolean(github?.connected),
      githubLogin: github?.githubLogin,
    });
    const showChecklist =
      onboarding &&
      onboarding.status !== 'completed' &&
      onboarding.status !== 'dismissed' &&
      onboarding.recommendedAction;
    const displayName = user.name?.trim() || user.email;

    return (
      <Shell>
        <BrandHeader badge="Ready" />

        <div className="space-y-1">
          <p className="truncate text-[13px] font-semibold tracking-tight text-[var(--px-text-primary)]">
            {displayName}
          </p>
          {user.name?.trim() ? (
            <p className="truncate text-[11px] text-[var(--px-text-muted)]">{user.email}</p>
          ) : null}
        </div>

        <WorkspaceSwitcher />

        <div className="grid grid-cols-2 gap-2">
          <StatusPill
            label="GitHub"
            value={githubLabel}
            tone={github?.connected ? 'good' : 'warn'}
          />
          <StatusPill label="Plan" value={planLabel} />
        </div>

        {showChecklist && onboarding.recommendedAction ? (
          <div className="rounded-3xl border border-[var(--px-accent)]/30 bg-[var(--px-accent-soft)] p-3.5">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--px-accent)]">
              Next step
            </p>
            <p className="mt-1.5 text-[13px] font-semibold tracking-tight text-[var(--px-text-primary)]">
              {onboarding.recommendedAction.title}
            </p>
            <p className="mt-1 text-[12px] leading-relaxed text-[var(--px-text-secondary)]">
              {onboarding.recommendedAction.body}
            </p>
            {onboarding.recommendedAction.ctaHref ? (
              <a
                href={onboarding.recommendedAction.ctaHref}
                target="_blank"
                rel="noreferrer"
                className="mt-2 inline-block text-[12px] font-semibold text-[var(--px-accent)] hover:underline"
              >
                {onboarding.recommendedAction.ctaLabel}
              </a>
            ) : (
              <p className="mt-2 text-[12px] font-semibold text-[var(--px-text-primary)]">
                {onboarding.recommendedAction.ctaLabel}
              </p>
            )}
            <button
              type="button"
              className="mt-2 block text-[11px] font-semibold text-[var(--px-text-muted)] hover:text-[var(--px-text-primary)]"
              onClick={() => void onDismissSetup()}
            >
              Dismiss setup
            </button>
          </div>
        ) : null}

        <p className="text-[12px] leading-relaxed text-[var(--px-text-muted)]">
          {!github?.connected
            ? GITHUB_WHY_CONNECT
            : 'Highlight text for Ask AI, or open a pull request to Review PR.'}
        </p>

        <div className="space-y-2">
          <a
            href={getDashboardAppUrl('/app', currentWorkspaceId)}
            target="_blank"
            rel="noreferrer"
            className="flex w-full items-center justify-center rounded-full bg-[var(--px-accent)] px-3 py-2.5 text-[13px] font-semibold text-[#042f2e] transition hover:brightness-110"
          >
            Open Studio
          </a>
          <div className="space-y-1.5">
            <NavLink href={getDashboardAppUrl('/app/settings', currentWorkspaceId)}>
              Settings & connections
            </NavLink>
            <NavLink href={getDashboardBillingUrl(currentWorkspaceId)}>Plan & usage</NavLink>
          </div>
          <button
            type="button"
            onClick={() => void onSignOut()}
            className="w-full rounded-full px-3 py-2 text-[12px] font-semibold text-[var(--px-text-muted)] transition hover:bg-[var(--px-hover)] hover:text-[var(--px-text-primary)]"
          >
            Sign out
          </button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <BrandHeader />
      <div className="space-y-1.5">
        <h1 className="text-[20px] font-semibold tracking-tight text-[var(--px-text-primary)]">
          {mode === 'login' ? 'Sign in' : 'Create account'}
        </h1>
        <p className="text-[13px] leading-relaxed text-[var(--px-text-secondary)]">
          Same account as Studio. Required for Ask AI.
        </p>
      </div>

      <form onSubmit={onSubmit} className="space-y-2.5">
        {mode === 'register' ? (
          <label className="grid gap-1 text-[11px] font-semibold text-[var(--px-text-muted)]">
            Name
            <input
              className="w-full rounded-2xl border border-[var(--px-border)] bg-[var(--px-surface-elevated)] px-3 py-2.5 text-[13px] font-medium text-[var(--px-text-primary)] outline-none placeholder:text-[var(--px-text-muted)] focus:border-[var(--px-accent)]/50"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Optional"
            />
          </label>
        ) : null}

        <label className="grid gap-1 text-[11px] font-semibold text-[var(--px-text-muted)]">
          Email
          <input
            className="w-full rounded-2xl border border-[var(--px-border)] bg-[var(--px-surface-elevated)] px-3 py-2.5 text-[13px] font-medium text-[var(--px-text-primary)] outline-none focus:border-[var(--px-accent)]/50"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>

        <label className="grid gap-1 text-[11px] font-semibold text-[var(--px-text-muted)]">
          Password
          <input
            className="w-full rounded-2xl border border-[var(--px-border)] bg-[var(--px-surface-elevated)] px-3 py-2.5 text-[13px] font-medium text-[var(--px-text-primary)] outline-none focus:border-[var(--px-accent)]/50"
            type="password"
            required
            minLength={8}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>

        {error ? <p className="text-[12px] font-medium text-red-500">{error}</p> : null}

        <button
          type="submit"
          disabled={pending}
          className="w-full rounded-full bg-[var(--px-accent)] px-3 py-2.5 text-[13px] font-semibold text-[#042f2e] transition hover:brightness-110 disabled:opacity-60"
        >
          {pending ? 'Signing in…' : mode === 'login' ? 'Sign in' : 'Create account'}
        </button>
      </form>

      <button
        type="button"
        className="text-left text-[12px] font-semibold text-[var(--px-accent)] hover:underline"
        onClick={() => {
          setMode(mode === 'login' ? 'register' : 'login');
          setError(null);
        }}
      >
        {mode === 'login' ? 'Need an account? Register' : 'Have an account? Sign in'}
      </button>
    </Shell>
  );
}

export default IndexPopup;
