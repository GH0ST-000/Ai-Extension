import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';

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
import { getSession } from './lib/services/auth-storage';
import { getGithubConnection } from './lib/services/github-api';
import { getDashboardBaseUrl, getDashboardBillingUrl } from './lib/workspace/dashboard-url';
import { useWorkspaceStore } from './lib/workspace/workspace.store';
import { WorkspaceSwitcher } from './lib/workspace/workspace-switcher';

type Mode = 'login' | 'register';

function BrandHeader() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
      <svg width={36} height={36} viewBox="0 0 128 128" aria-hidden style={{ borderRadius: 12 }}>
        <rect width="128" height="128" rx="32" fill="#0B1220" />
        <g fill="none" stroke="#14B8A6" strokeWidth="18" strokeLinecap="round">
          <path d="M34 34 L94 94" />
          <path d="M94 34 L34 94" />
        </g>
        <circle cx="94" cy="34" r="9" fill="#F59E0B" />
        <circle cx="94" cy="34" r="3.5" fill="#FFF7ED" fillOpacity="0.9" />
      </svg>
      <div>
        <p
          style={{
            margin: 0,
            fontSize: 14,
            fontWeight: 700,
            letterSpacing: '-0.02em',
            color: '#0f172a',
          }}
        >
          {APP_NAME}
        </p>
        <p
          style={{
            margin: '2px 0 0',
            fontSize: 10,
            fontWeight: 600,
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            color: '#64748b',
          }}
        >
          Extension
        </p>
      </div>
    </div>
  );
}

function StatusRow({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        gap: 12,
        fontSize: 12,
        lineHeight: 1.4,
      }}
    >
      <span style={{ color: '#64748b', fontWeight: 600 }}>{label}</span>
      <span style={{ color: '#0f172a', fontWeight: 600, textAlign: 'right' }}>{value}</span>
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

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const session = await getSession();
      if (cancelled) return;

      setUser(session?.user ?? null);
      setLoading(false);

      if (!session) {
        setShowWelcome(true);
        return;
      }

      void useWorkspaceStore.getState().bootstrap();
      try {
        const [githubStatus, onboardingView] = await Promise.all([
          getGithubConnection().catch(() => ({ connected: false }) as GitHubConnectionStatus),
          fetchOnboarding().catch(() => null),
        ]);
        if (cancelled) return;
        setGithub(githubStatus);
        setOnboarding(onboardingView);
        if (
          onboardingView &&
          (onboardingView.status === 'not_started' ||
            (!onboardingView.preferences.welcomeSeen && !onboardingView.steps.firstActionCompleted))
        ) {
          setShowWelcome(true);
        }
      } catch {
        // Ignore — status rows degrade gracefully
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
      void useWorkspaceStore.getState().bootstrap();
      const [githubStatus, onboardingView] = await Promise.all([
        getGithubConnection().catch(() => ({ connected: false }) as GitHubConnectionStatus),
        fetchOnboarding().catch(() => null),
      ]);
      setGithub(githubStatus);
      setOnboarding(onboardingView);
      await markWelcomeSeen();
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
      <div style={shellStyle}>
        <BrandHeader />
        <p style={{ margin: '12px 0 0', fontSize: 13, color: '#64748b' }}>Loading…</p>
      </div>
    );
  }

  if (!user && showWelcome) {
    return (
      <div style={shellStyle}>
        <BrandHeader />
        <h1 style={titleStyle}>Understand and act where you work</h1>
        <p style={bodyStyle}>
          Select text on any page for quick AI actions, or connect GitHub for PR reviews, CI
          analysis, and confirmed writes.
        </p>
        <p style={{ ...bodyStyle, marginTop: 10, fontSize: 12 }}>
          {GITHUB_WRITE_CONFIRMATION_NOTE}
        </p>
        <button
          type="button"
          style={{ ...primaryButtonStyle, marginTop: 14 }}
          onClick={onGetStarted}
        >
          Get Started
        </button>
        <button
          type="button"
          style={linkButtonStyle}
          onClick={() => {
            setShowWelcome(false);
          }}
        >
          Try with selected text after sign-in
        </button>
      </div>
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

    return (
      <div style={shellStyle}>
        <BrandHeader />
        <h1 style={titleStyle}>Ready</h1>
        <p style={bodyStyle}>
          {user.name?.trim() ? `${user.name} · ` : ''}
          {user.email}
        </p>
        <WorkspaceSwitcher />

        <div
          style={{
            marginTop: 12,
            display: 'grid',
            gap: 8,
            padding: 10,
            borderRadius: 12,
            border: '1px solid #e2e8f0',
            background: '#f8fafc',
          }}
        >
          <StatusRow
            label="Workspace"
            value={workspace?.workspace.name ?? (workspaceLoading ? 'Loading…' : '—')}
          />
          <StatusRow label="GitHub" value={githubLabel} />
          <StatusRow label="Plan" value={planLabel} />
        </div>

        {showChecklist && onboarding.recommendedAction ? (
          <div
            style={{
              marginTop: 12,
              padding: 10,
              borderRadius: 12,
              border: '1px solid #99f6e4',
              background: '#f0fdfa',
            }}
          >
            <p style={{ margin: 0, fontSize: 12, fontWeight: 700, color: '#0f766e' }}>
              {onboarding.recommendedAction.title}
            </p>
            <p style={{ ...bodyStyle, marginTop: 6, fontSize: 12 }}>
              {onboarding.recommendedAction.body}
            </p>
            {onboarding.recommendedAction.ctaHref ? (
              <a
                href={onboarding.recommendedAction.ctaHref}
                target="_blank"
                rel="noreferrer"
                style={{ ...linkButtonStyle, display: 'inline-block', marginTop: 8 }}
              >
                {onboarding.recommendedAction.ctaLabel}
              </a>
            ) : (
              <p style={{ ...bodyStyle, marginTop: 8, fontSize: 12, fontWeight: 600 }}>
                {onboarding.recommendedAction.ctaLabel}
              </p>
            )}
            <button
              type="button"
              style={{ ...linkButtonStyle, marginTop: 8 }}
              onClick={() => void onDismissSetup()}
            >
              Dismiss setup
            </button>
          </div>
        ) : null}

        {!github?.connected ? (
          <p style={{ ...bodyStyle, marginTop: 12, fontSize: 12 }}>{GITHUB_WHY_CONNECT}</p>
        ) : (
          <p style={{ ...bodyStyle, marginTop: 12, fontSize: 12 }}>
            Highlight text for Ask AI, or open a pull request to Review PR.
          </p>
        )}

        <div style={{ display: 'grid', gap: 8, marginTop: 14 }}>
          <a
            href={`${getDashboardBaseUrl()}/app`}
            target="_blank"
            rel="noreferrer"
            style={{
              ...secondaryButtonStyle,
              marginTop: 0,
              textAlign: 'center',
              textDecoration: 'none',
            }}
          >
            Open dashboard
          </a>
          <a
            href={`${getDashboardBaseUrl()}/app/settings`}
            target="_blank"
            rel="noreferrer"
            style={{
              ...secondaryButtonStyle,
              marginTop: 0,
              textAlign: 'center',
              textDecoration: 'none',
            }}
          >
            Settings & connections
          </a>
          <a
            href={getDashboardBillingUrl()}
            target="_blank"
            rel="noreferrer"
            style={{
              ...secondaryButtonStyle,
              marginTop: 0,
              textAlign: 'center',
              textDecoration: 'none',
            }}
          >
            Plan & usage
          </a>
          <button
            type="button"
            style={{ ...secondaryButtonStyle, marginTop: 0 }}
            onClick={() => void onSignOut()}
          >
            Sign out
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={shellStyle}>
      <BrandHeader />
      <h1 style={titleStyle}>{mode === 'login' ? 'Sign in' : 'Create account'}</h1>
      <p style={bodyStyle}>
        Authentication is required for Ask AI. Use the same account as the dashboard.
      </p>

      <form onSubmit={onSubmit} style={{ marginTop: 14, display: 'grid', gap: 10 }}>
        {mode === 'register' ? (
          <label style={labelStyle}>
            Name
            <input
              style={inputStyle}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Optional"
            />
          </label>
        ) : null}

        <label style={labelStyle}>
          Email
          <input
            style={inputStyle}
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>

        <label style={labelStyle}>
          Password
          <input
            style={inputStyle}
            type="password"
            required
            minLength={8}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>

        {error ? <p style={errorStyle}>{error}</p> : null}

        <button type="submit" style={primaryButtonStyle} disabled={pending}>
          {pending ? 'Signing in…' : mode === 'login' ? 'Sign in' : 'Create account'}
        </button>
      </form>

      <button
        type="button"
        style={linkButtonStyle}
        onClick={() => {
          setMode(mode === 'login' ? 'register' : 'login');
          setError(null);
        }}
      >
        {mode === 'login' ? 'Need an account? Register' : 'Have an account? Sign in'}
      </button>
    </div>
  );
}

const shellStyle: CSSProperties = {
  width: 320,
  padding: 16,
  fontFamily: 'ui-sans-serif, system-ui, sans-serif',
  color: '#0f172a',
};

const titleStyle: CSSProperties = {
  margin: '8px 0 6px',
  fontSize: 18,
};

const bodyStyle: CSSProperties = {
  margin: 0,
  fontSize: 13,
  lineHeight: 1.45,
  color: '#475569',
};

const labelStyle: CSSProperties = {
  display: 'grid',
  gap: 4,
  fontSize: 12,
  fontWeight: 600,
};

const inputStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  borderRadius: 10,
  border: '1px solid #cbd5e1',
  padding: '8px 10px',
  fontSize: 13,
  fontWeight: 400,
};

const primaryButtonStyle: CSSProperties = {
  border: 'none',
  borderRadius: 10,
  background: '#0f172a',
  color: '#fff',
  fontSize: 13,
  fontWeight: 600,
  padding: '10px 12px',
  cursor: 'pointer',
};

const secondaryButtonStyle: CSSProperties = {
  ...primaryButtonStyle,
  marginTop: 14,
  background: '#fff',
  color: '#0f172a',
  border: '1px solid #cbd5e1',
};

const linkButtonStyle: CSSProperties = {
  marginTop: 12,
  border: 'none',
  background: 'transparent',
  color: '#0f766e',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
  padding: 0,
  textAlign: 'left',
};

const errorStyle: CSSProperties = {
  margin: 0,
  fontSize: 12,
  color: '#b91c1c',
};

export default IndexPopup;
