'use client';

import type { ReactNode } from 'react';

import { BrandMark } from './brand-mark';
import { ThemeToggle } from './theme-toggle';

/** Same frame as the sign-in page: atmosphere, brand mark and a glass card. */
export function AuthShell({
  eyebrow,
  title,
  subtitle,
  children,
}: {
  eyebrow: string;
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
}) {
  return (
    <main className="atmosphere relative flex min-h-screen items-center justify-center overflow-hidden px-6 py-12">
      <div className="pointer-events-none absolute inset-0 grid-fade opacity-40" aria-hidden />
      <div
        className="pointer-events-none absolute left-[10%] top-[15%] h-72 w-72 rounded-full bg-accent/25 blur-3xl float-soft"
        aria-hidden
      />
      <div className="absolute right-6 top-6 z-10">
        <ThemeToggle compact />
      </div>
      <div className="relative w-full max-w-md rise-in">
        <div className="mb-8 flex justify-center">
          <BrandMark size="lg" />
        </div>
        <div className="panel-glass rounded-3xl p-7 shadow-panel md:p-8">
          <p className="text-center text-[11px] font-semibold uppercase tracking-[0.2em] text-accent">
            {eyebrow}
          </p>
          <h1 className="mt-3 text-center font-display text-3xl font-semibold tracking-tight text-ink">
            {title}
          </h1>
          {subtitle ? (
            <p className="mt-2 text-center text-sm text-muted-foreground">{subtitle}</p>
          ) : null}
          {children}
        </div>
      </div>
    </main>
  );
}

export const AUTH_INPUT_CLASS =
  'w-full rounded-xl border border-line bg-panel/80 px-3.5 py-2.5 text-sm text-ink outline-none ring-accent/30 placeholder:text-muted-foreground focus:ring-2';
export const AUTH_BUTTON_CLASS =
  'w-full rounded-xl bg-ink px-4 py-3 text-sm font-semibold text-inverse transition hover:opacity-90 disabled:opacity-60';
