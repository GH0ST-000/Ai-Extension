'use client';

import type { ThemePreference } from '../lib/theme';
import { useTheme } from './theme-provider';

const OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'Auto' },
];

type ThemeToggleProps = {
  compact?: boolean;
};

export function ThemeToggle({ compact = false }: ThemeToggleProps) {
  const { preference, setPreference } = useTheme();

  return (
    <div
      role="group"
      aria-label="Color theme"
      className={[
        'inline-flex items-center rounded-xl border border-line bg-panel/80 p-0.5',
        compact ? 'text-[11px]' : 'text-xs',
      ].join(' ')}
    >
      {OPTIONS.map((option) => {
        const active = preference === option.value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => setPreference(option.value)}
            className={[
              'rounded-lg px-2.5 py-1.5 font-semibold transition',
              active ? 'bg-ink text-inverse' : 'text-muted-foreground hover:text-ink',
            ].join(' ')}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
