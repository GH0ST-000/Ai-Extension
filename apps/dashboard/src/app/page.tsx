import Link from 'next/link';

import { APP_NAME } from '@project-x/shared';

import { BrandGlyph, BrandMark } from '../components/brand-mark';
import { ThemeToggle } from '../components/theme-toggle';

export default function HomePage() {
  return (
    <main className="atmosphere relative min-h-screen overflow-hidden">
      <div className="pointer-events-none absolute inset-0 grid-fade opacity-50" aria-hidden />
      <div
        className="pointer-events-none absolute left-[-10%] top-[-10%] h-[42rem] w-[42rem] rounded-full bg-accent/20 blur-3xl float-soft"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute bottom-[-20%] right-[-8%] h-[36rem] w-[36rem] rounded-full bg-spark/15 blur-3xl"
        aria-hidden
      />

      <div className="relative mx-auto flex w-full max-w-6xl flex-col px-6 py-8 md:px-10">
        <header className="flex items-center justify-between rise-in">
          <BrandMark />
          <div className="flex items-center gap-2 sm:gap-3">
            <ThemeToggle compact />
            <Link
              href="/login"
              className="rounded-xl px-3 py-2 text-sm font-semibold text-muted-foreground transition hover:text-ink"
            >
              Sign in
            </Link>
            <Link
              href="/app"
              className="rounded-xl bg-ink px-3.5 py-2 text-sm font-semibold text-inverse transition hover:opacity-90"
            >
              Open studio
            </Link>
          </div>
        </header>

        {/* Hero — first viewport stays lean */}
        <section className="flex min-h-[78vh] flex-col justify-center py-16 md:py-20">
          <div className="rise-in-delay-1 max-w-3xl">
            <div className="mb-6">
              <BrandGlyph size={72} className="rounded-[1.35rem] shadow-soft" />
            </div>
            <p className="mb-5 font-display text-5xl font-semibold tracking-tight text-ink md:text-7xl">
              {APP_NAME}
            </p>
            <h1 className="max-w-2xl font-display text-3xl font-semibold leading-[1.08] tracking-tight text-ink text-balance md:text-5xl">
              AI that reads the page with you.
            </h1>
            <p className="mt-5 max-w-xl text-lg leading-relaxed text-muted-foreground md:text-xl">
              Highlight anything in Chrome. Smart actions, in-place replace, full PR review, and a
              safe patch preview — without leaving the tab.
            </p>

            <div className="mt-9 flex flex-wrap gap-3">
              <Link
                href="/login"
                className="rounded-2xl bg-accent px-5 py-3 text-sm font-semibold text-accent-foreground shadow-soft transition hover:brightness-110"
              >
                Sign in
              </Link>
              <Link
                href="/login"
                className="rounded-2xl border border-line bg-panel/75 px-5 py-3 text-sm font-semibold text-ink transition hover:bg-panel"
              >
                Create account
              </Link>
            </div>
          </div>
        </section>

        {/* Capability story — one job per section */}
        <section className="rise-in border-t border-line/70 py-20">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-accent">
            Smart Actions
          </p>
          <h2 className="mt-3 max-w-2xl font-display text-3xl font-semibold tracking-tight text-ink md:text-4xl">
            The menu reorders itself to the selection.
          </h2>
          <p className="mt-4 max-w-xl text-base leading-relaxed text-muted-foreground">
            Code, errors, short phrases, and prose each surface the most useful Ask AI action first
            — locally, with no extra model call before you choose.
          </p>
          <ul className="mt-10 max-w-2xl space-y-4 text-sm text-ink">
            {[
              ['Code & diffs', 'Explain Code, Code Review, and Suggest Fix rise to the top'],
              ['Errors', 'Explain leads, then Explain Code'],
              ['Prose', 'Summarize and Improve Writing come first'],
            ].map(([label, detail]) => (
              <li key={label} className="flex gap-4 border-b border-line/60 pb-4">
                <span className="w-36 shrink-0 font-semibold">{label}</span>
                <span className="text-muted-foreground">{detail}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="rise-in border-t border-line/70 py-20">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-accent">
            In-place Replace
          </p>
          <h2 className="mt-3 max-w-2xl font-display text-3xl font-semibold tracking-tight text-ink md:text-4xl">
            Write back into the field you selected.
          </h2>
          <p className="mt-4 max-w-xl text-base leading-relaxed text-muted-foreground">
            Improve Writing or Translate on a textarea, text input, or contenteditable — then
            Replace instead of copy-paste. Password and locked fields stay untouched.
          </p>
        </section>

        <section className="rise-in border-t border-line/70 py-20">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-accent">
            GitHub intelligence
          </p>
          <h2 className="mt-3 max-w-2xl font-display text-3xl font-semibold tracking-tight text-ink md:text-4xl">
            Review one hunk — or the whole PR.
          </h2>
          <p className="mt-4 max-w-xl text-base leading-relaxed text-muted-foreground">
            On GitHub PRs, Project X reads title, body, branches, and nearby diff context. Code
            Review targets your selection; Review Entire PR analyzes a bounded multi-file slice from
            the Files tab.
          </p>
        </section>

        <section className="rise-in border-t border-line/70 py-20">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-accent">
            Review Entire PR
          </p>
          <h2 className="mt-3 max-w-2xl font-display text-3xl font-semibold tracking-tight text-ink md:text-4xl">
            Summary, risk findings, then a fix for one issue.
          </h2>
          <p className="mt-4 max-w-xl text-base leading-relaxed text-muted-foreground">
            Open the PR Files tab, highlight anything to open Ask AI, and run Review Entire PR.
            You’ll get an overall summary plus severity-tagged findings — then Suggest Fix on a
            single finding when you want a patch preview.
          </p>
          <ol className="mt-10 max-w-2xl space-y-4 text-sm text-ink">
            {[
              ['Files tab', 'Load the PR files so diffs are in the page'],
              ['Review Entire PR', 'Collect bounded changed-file context and stream risks'],
              ['Inspect findings', 'Read severity, file path, and why it matters'],
              ['Suggest Fix', 'Generate a minimal patch for one finding — Copy Fix only'],
            ].map(([label, detail], index) => (
              <li key={label} className="flex gap-4 border-b border-line/60 pb-4">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-ink font-display text-xs font-bold text-inverse">
                  {index + 1}
                </span>
                <div className="min-w-0">
                  <p className="font-semibold">{label}</p>
                  <p className="mt-0.5 text-muted-foreground">{detail}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="rise-in border-t border-line/70 py-20">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-accent">
            Suggest Fix
          </p>
          <h2 className="mt-3 max-w-2xl font-display text-3xl font-semibold tracking-tight text-ink md:text-4xl">
            From a finding to a patch you can copy.
          </h2>
          <p className="mt-4 max-w-xl text-base leading-relaxed text-muted-foreground">
            After Code Review or a PR finding, Suggest Fix proposes a minimal correction. You see a
            safe patch preview in the floating panel, then Copy Fix — Project X never writes to
            GitHub for you.
          </p>
          <div className="mt-10 flex flex-wrap gap-3">
            <Link
              href="/login"
              className="rounded-2xl bg-ink px-5 py-3 text-sm font-semibold text-inverse transition hover:opacity-90"
            >
              Open the studio
            </Link>
            <p className="self-center text-sm text-muted-foreground">
              Same account unlocks the extension and settings.
            </p>
          </div>
        </section>

        <footer className="border-t border-line/70 py-10 text-sm text-muted-foreground">
          {APP_NAME} · Chrome extension + studio
        </footer>
      </div>
    </main>
  );
}
