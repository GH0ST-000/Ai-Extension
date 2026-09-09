'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { applyThemeClass, readStoredTheme, storeTheme, type ThemePreference } from '../lib/theme';

type ThemeContextValue = {
  preference: ThemePreference;
  setPreference: (value: ThemePreference) => void;
  resolved: 'light' | 'dark';
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>('system');
  const [resolved, setResolved] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    const stored = readStoredTheme();
    setPreferenceState(stored);
    applyThemeClass(stored);
    setResolved(
      stored === 'system'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
          ? 'dark'
          : 'light'
        : stored,
    );
  }, []);

  useEffect(() => {
    applyThemeClass(preference);
    storeTheme(preference);

    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const syncResolved = () => {
      const next = preference === 'system' ? (media.matches ? 'dark' : 'light') : preference;
      setResolved(next);
      applyThemeClass(preference);
    };

    syncResolved();
    media.addEventListener('change', syncResolved);
    return () => media.removeEventListener('change', syncResolved);
  }, [preference]);

  const setPreference = useCallback((value: ThemePreference) => {
    setPreferenceState(value);
  }, []);

  const value = useMemo(
    () => ({ preference, setPreference, resolved }),
    [preference, setPreference, resolved],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used within ThemeProvider');
  }
  return ctx;
}
