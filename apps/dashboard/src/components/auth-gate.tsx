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
import { clearSession, getStoredUser, type StoredAuthUser } from '../lib/auth-storage';
import { publishExtensionSync } from '../lib/extension-handoff';

const AuthUserContext = createContext<StoredAuthUser | null>(null);

/** Keep this short — a hung /me or refresh must not brick the shell. */
const SESSION_CHECK_TIMEOUT_MS = 3_500;

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
  color: 'var(--foreground, #94a3b8)',
  fontFamily: 'ui-sans-serif, system-ui, sans-serif',
};

export function useAuthUser(): StoredAuthUser | null {
  return useContext(AuthUserContext);
}

export function AuthGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  // Start empty on both server and client to keep hydration consistent;
  // the cached user is applied in the effect below.
  const [user, setUser] = useState<StoredAuthUser | null>(null);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<'checking' | 'redirecting' | 'error'>('checking');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), SESSION_CHECK_TIMEOUT_MS);

    async function verify() {
      setStatus('checking');
      setErrorMessage(null);

      // Optimistic: paint shell from cache while we revalidate.
      const cached = getStoredUser();
      if (cached) {
        setUser(cached);
        setReady(true);
      }

      try {
        const me = await fetchMe({ signal: controller.signal });
        if (!alive) return;
        setUser(me);
        setReady(true);
        void publishExtensionSync();
      } catch {
        if (!alive) return;

        if (controller.signal.aborted) {
          const fallback = getStoredUser();
          if (fallback) {
            setUser(fallback);
            setReady(true);
            return;
          }
          setReady(false);
          setStatus('error');
          setErrorMessage('Session check timed out. Please check your connection and try again.');
          return;
        }

        clearSession();
        setReady(false);
        setStatus('redirecting');
        router.replace('/login');
      }
    }

    void verify();
    return () => {
      alive = false;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [router, retryToken]);

  if (!ready) {
    if (status === 'error') {
      return (
        <div style={shellStyle} role="alert">
          <p style={{ margin: 0, color: 'inherit', fontWeight: 600 }}>
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
                border: '1px solid #475569',
                background: 'transparent',
                color: 'inherit',
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
