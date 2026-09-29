'use client';

import type { ThemePreference } from '../lib/theme';
import { useTheme } from './theme-provider';

const OPTIONS: { value: ThemePreference; label: string; short: string }[] = [
  { value: 'light', label: 'Light', short: 'L' },
  { value: 'dark', label: 'Dark', short: 'D' },
  { value: 'system', label: 'Auto', short: 'A' },
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
            aria-label={option.label}
            aria-pressed={active}
            title={option.label}
            onClick={() => setPreference(option.value)}
            className={[
              'rounded-lg font-semibold transition',
              compact ? 'min-w-[1.75rem] px-1.5 py-1.5 sm:min-w-0 sm:px-2.5' : 'px-2.5 py-1.5',
              active ? 'bg-ink text-inverse' : 'text-muted-foreground hover:text-ink',
            ].join(' ')}
          >
            <span className={compact ? 'sm:hidden' : 'hidden'}>{option.short}</span>
            <span className={compact ? 'hidden sm:inline' : undefined}>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
