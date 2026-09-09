import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';

import { APP_NAME } from '@project-x/shared';
import type { AuthUser } from '@project-x/types';

import { AuthClientError, login, register, signOut } from './lib/services/auth-client';
import { getSession } from './lib/services/auth-storage';

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
          Studio
        </p>
      </div>
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

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const session = await getSession();
      if (!cancelled) {
        setUser(session?.user ?? null);
        setLoading(false);
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
    } catch (err) {
      setError(err instanceof AuthClientError ? err.message : 'Unable to authenticate.');
    } finally {
      setPending(false);
    }
  }

  async function onSignOut() {
    await signOut();
    setUser(null);
  }

  if (loading) {
    return (
      <div style={shellStyle}>
        <BrandHeader />
        <p style={{ margin: '12px 0 0', fontSize: 13, color: '#64748b' }}>Loading…</p>
      </div>
    );
  }

  if (user) {
    return (
      <div style={shellStyle}>
        <BrandHeader />
        <h1 style={titleStyle}>Signed in</h1>
        <p style={bodyStyle}>
          {user.name?.trim() ? `${user.name} · ` : ''}
          {user.email}
        </p>
        <p style={{ ...bodyStyle, marginTop: 10 }}>
          Highlight text on any page to open Ask AI. Tune length and context in the dashboard
          settings.
        </p>
        <button type="button" style={secondaryButtonStyle} onClick={() => void onSignOut()}>
          Sign out
        </button>
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
          {pending ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Register'}
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
