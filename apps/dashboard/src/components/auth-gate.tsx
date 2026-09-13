'use client';

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';

import { fetchMe } from '../lib/api';
import {
  clearSession,
  getAccessToken,
  getStoredUser,
  type StoredAuthUser,
} from '../lib/auth-storage';

const AuthUserContext = createContext<StoredAuthUser | null>(null);

const SESSION_CHECK_TIMEOUT_MS = 6_000;

const shellStyle: CSSProperties = {
  display: 'flex',
  minHeight: '40vh',
  alignItems: 'center',
  justifyContent: 'center',
  flexDirection: 'column',
  gap: 12,
  padding: 24,
  textAlign: 'center',
  fontSize: 14,
  color: '#64748b',
  fontFamily: 'ui-sans-serif, system-ui, sans-serif',
};

export function useAuthUser(): StoredAuthUser | null {
  return useContext(AuthUserContext);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error('SESSION_CHECK_TIMEOUT'));
    }, ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        window.clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export function AuthGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<StoredAuthUser | null>(null);
  const [status, setStatus] = useState<'checking' | 'redirecting' | 'error'>('checking');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    let alive = true;

    async function verify() {
      setStatus('checking');
      setErrorMessage(null);
      setReady(false);

      const token = getAccessToken();
      if (!token) {
        if (!alive) return;
        setStatus('redirecting');
        router.replace('/login');
        return;
      }

      try {
        const me = await withTimeout(fetchMe(), SESSION_CHECK_TIMEOUT_MS);
        if (!alive) return;
        setUser(me);
        setReady(true);
      } catch (err) {
        if (!alive) return;

        const timedOut =
          err instanceof Error &&
          (err.message === 'SESSION_CHECK_TIMEOUT' || err.name === 'AbortError');

        if (timedOut) {
          // Prefer cached user so a flaky API does not hard-lock the dashboard.
          const cached = getStoredUser();
          if (cached) {
            setUser(cached);
            setReady(true);
            return;
          }
          setStatus('error');
          setErrorMessage('Session check timed out. Confirm the API is running on port 3001.');
          return;
        }

        clearSession();
        setStatus('redirecting');
        router.replace('/login');
      }
    }

    void verify();
    return () => {
      alive = false;
    };
  }, [router, retryToken]);

  if (!ready) {
    if (status === 'error') {
      return (
        <div style={shellStyle} role="alert">
          <p style={{ margin: 0, color: '#0f172a', fontWeight: 600 }}>
            {errorMessage ?? 'Unable to verify session.'}
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}>
            <button
              type="button"
              style={{
                border: 'none',
                borderRadius: 12,
                background: '#0f172a',
                color: '#fff',
                fontWeight: 600,
                padding: '8px 14px',
                cursor: 'pointer',
              }}
              onClick={() => setRetryToken((value) => value + 1)}
            >
              Retry
            </button>
            <button
              type="button"
              style={{
                borderRadius: 12,
                border: '1px solid #cbd5e1',
                background: '#fff',
                color: '#0f172a',
                fontWeight: 600,
                padding: '8px 14px',
                cursor: 'pointer',
              }}
              onClick={() => {
                clearSession();
                router.replace('/login');
              }}
            >
              Sign in again
            </button>
          </div>
        </div>
      );
    }

    return (
      <div style={shellStyle} aria-busy="true">
        {status === 'redirecting' ? 'Redirecting to sign in…' : 'Checking session…'}
      </div>
    );
  }

  return (
    <AuthUserContext.Provider value={user ?? getStoredUser()}>{children}</AuthUserContext.Provider>
  );
}
