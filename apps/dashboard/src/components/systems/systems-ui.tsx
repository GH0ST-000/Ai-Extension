'use client';

import type { ReactNode } from 'react';

/** Small presentational primitives shared by the Systems page (Studio design language). */

export const BUTTON_PRIMARY =
  'inline-flex items-center justify-center gap-2 rounded-xl bg-ink px-4 py-2 text-sm font-semibold text-inverse transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-panel';
export const BUTTON_ACCENT =
  'inline-flex items-center justify-center gap-2 rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-accent-foreground shadow-soft transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-panel';
export const BUTTON_SECONDARY =
  'inline-flex items-center justify-center gap-2 rounded-xl border border-line bg-panel px-4 py-2 text-sm font-semibold text-ink transition hover:border-accent/40 hover:bg-mist disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-panel';
export const BUTTON_GHOST =
  'inline-flex items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-muted-foreground transition hover:bg-mist hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-panel';
export const BUTTON_DANGER =
  'inline-flex items-center justify-center gap-2 rounded-xl border border-[#b42318]/40 bg-panel px-4 py-2 text-sm font-semibold text-[#b42318] transition hover:bg-[#b42318]/10 disabled:cursor-not-allowed disabled:opacity-50 dark:text-[#f97066] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-2 focus-visible:ring-offset-panel';
export const INPUT_CLASS =
  'w-full rounded-xl border border-line bg-mist px-3 py-2.5 text-sm text-ink outline-none ring-accent/30 placeholder:text-muted-foreground/70 focus:ring-2 aria-[invalid=true]:border-[#b42318]/60';

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'muted';
}) {
  const styles = {
    neutral: 'border-line bg-mist text-ink',
    accent: 'border-accent/40 bg-accent-soft text-ink',
    muted: 'border-line bg-panel text-muted-foreground',
  }[tone];
  return (
    <span
      className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-semibold ${styles}`}
    >
      {children}
    </span>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span
      role={label ? 'status' : undefined}
      aria-label={label}
      className="inline-block size-4 shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none"
    />
  );
}

/** Callout: `info` for neutral guidance, `warning` only for real problems. */
export function Callout({
  tone = 'info',
  title,
  children,
  action,
  role,
}: {
  tone?: 'info' | 'success' | 'warning' | 'error';
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  role?: 'status' | 'alert';
}) {
  const styles = {
    info: 'border-line bg-mist/60',
    success: 'border-accent/40 bg-accent-soft/60',
    warning: 'border-[#b54708]/35 bg-[#fffaeb] dark:border-[#f79009]/40 dark:bg-[#f79009]/10',
    error: 'border-[#b42318]/35 bg-[#fef3f2] dark:border-[#f97066]/40 dark:bg-[#f97066]/10',
  }[tone];
  return (
    <div className={`rounded-2xl border px-4 py-3 ${styles}`} role={role}>
      <p className="text-sm font-semibold text-ink">{title}</p>
      {children ? <div className="mt-1 text-sm text-muted-foreground">{children}</div> : null}
      {action ? <div className="mt-3 flex flex-wrap gap-2">{action}</div> : null}
    </div>
  );
}

export function SectionCard({
  id,
  title,
  description,
  actions,
  children,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={`${id}-heading`}
      className="overflow-hidden rounded-3xl border border-line bg-panel/75 shadow-panel"
    >
      <div className="flex flex-col gap-3 border-b border-line/80 px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2
            id={`${id}-heading`}
            className="font-display text-base font-semibold tracking-tight text-ink"
          >
            {title}
          </h2>
          {description ? (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap gap-2">{actions}</div> : null}
      </div>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

/** Calm, in-card empty state: what it means + what to do next. */
export function InlineEmpty({
  title,
  description,
  action,
}: {
  title: string;
  description: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-line px-4 py-6 text-center">
      <p className="text-sm font-semibold text-ink">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-sm leading-relaxed text-muted-foreground">
        {description}
      </p>
      {action ? <div className="mt-3 flex justify-center gap-2">{action}</div> : null}
    </div>
  );
}
