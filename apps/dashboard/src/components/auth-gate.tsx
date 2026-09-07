'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';

import { fetchMe } from '../lib/api';
import {
  clearSession,
  getAccessToken,
  getStoredUser,
  type StoredAuthUser,
} from '../lib/auth-storage';

const AuthUserContext = createContext<StoredAuthUser | null>(null);

export function useAuthUser(): StoredAuthUser | null {
  return useContext(AuthUserContext);
}

export function AuthGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<StoredAuthUser | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function verify() {
      const token = getAccessToken();
      if (!token) {
        router.replace('/login');
        return;
      }

      try {
        const me = await fetchMe();
        if (cancelled) {
          return;
        }
        setUser(me);
        setReady(true);
      } catch {
        clearSession();
        if (!cancelled) {
          router.replace('/login');
        }
      }
    }

    void verify();
    return () => {
      cancelled = true;
    };
  }, [router]);

  if (!ready) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-sm text-muted-foreground">
        Checking session…
      </div>
    );
  }

  return (
    <AuthUserContext.Provider value={user ?? getStoredUser()}>{children}</AuthUserContext.Provider>
  );
}
