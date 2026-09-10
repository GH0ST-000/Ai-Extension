import Link from 'next/link';

import { APP_NAME } from '@project-x/shared';

import { BrandGlyph } from '../components/brand-mark';
import { LandingHeader } from '../components/landing-header';
import { LandingHeroCtas } from '../components/landing-hero-ctas';

const CAPABILITIES = [
  {
    label: 'Smart Actions',
    title: 'Menu follows the selection',
    copy: 'Code, errors, and prose reorder Ask AI locally — no extra model call before you choose.',
  },
  {
    label: 'Replace',
    title: 'Write back in place',
    copy: 'Improve or translate in a field, then Replace. Password and locked inputs stay untouched.',
  },
  {
    label: 'Error Intelligence',
    title: 'Stack → next step',
    copy: 'On-device classification, secret redaction, then Understand Error, Find Root Cause, or Suggest Fix.',
  },
  {
    label: 'Suggest Fix',
    title: 'Patch you can copy',
    copy: 'Minimal correction with a safe preview. Project X never applies the patch or pushes code.',
  },
] as const;

const PR_FLOW = [
  ['Review', 'Bounded multi-file PR analysis into a filterable report'],
  ['Curate', 'Add findings to a Review Draft — ignored items stay out'],
  ['Confirm', 'COMMENT / APPROVE / REQUEST_CHANGES only after you preview'],
  ['Submit', 'Encrypted PAT on the API · idempotent · View on GitHub'],
] as const;

const JIRA_FLOW = [
  ['Connect', 'Email + API token + *.atlassian.net — encrypted on the API, never in the extension'],
  ['Open issue', 'Extension detects the Jira Cloud issue and loads normalized context'],
  ['Understand', 'Summarize · Acceptance Criteria · Technical Plan · Risks & Questions'],
  ['Compare', 'Link a PR by issue key, then compare requirement vs diff — read-only on Jira'],
] as const;

export default function HomePage() {
  return (
    <main className="atmosphere relative min-h-screen overflow-hidden">
      <div className="pointer-events-none absolute inset-0 grid-fade opacity-50" aria-hidden />
      <div
        className="pointer-events-none absolute left-[-10%] top-[-12%] h-[36rem] w-[36rem] rounded-full bg-accent/20 blur-3xl float-soft"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute bottom-[-18%] right-[-10%] h-[30rem] w-[30rem] rounded-full bg-spark/15 blur-3xl"
        aria-hidden
      />

      <div className="relative mx-auto flex w-full max-w-6xl flex-col px-6 py-6 md:px-10 md:py-8">
        <LandingHeader />

        <section className="flex min-h-[68vh] flex-col justify-center py-12 md:min-h-[72vh] md:py-14">
          <div className="rise-in-delay-1 max-w-3xl">
            <BrandGlyph size={56} className="mb-5 rounded-[1.15rem] shadow-soft" />
            <p className="mb-3 font-display text-4xl font-semibold tracking-tight text-ink md:text-6xl">
              {APP_NAME}
            </p>
            <h1 className="max-w-2xl font-display text-2xl font-semibold leading-[1.12] tracking-tight text-ink text-balance md:text-4xl">
              AI that reads the page with you.
            </h1>
            <p className="mt-4 max-w-xl text-base leading-relaxed text-muted-foreground md:text-lg">
              Highlight anything in Chrome. Smart actions, PR reviews, Jira issue intelligence, and
              confirmed GitHub writes — without leaving the tab.
            </p>
            <LandingHeroCtas />
          </div>
        </section>

        <section className="rise-in border-t border-line/70 py-12 md:py-14">
          <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div className="max-w-xl">
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-accent">
                In the extension
              </p>
              <h2 className="mt-2 font-display text-2xl font-semibold tracking-tight text-ink md:text-3xl">
                Built for the tab you already have open.
              </h2>
            </div>
            <p className="max-w-sm text-sm leading-relaxed text-muted-foreground md:text-right">
              Ranking and error detection run on-device. OpenAI keys, GitHub PATs, and Jira tokens
              stay on the API.
            </p>
          </div>

          <div className="mt-8 grid gap-x-10 gap-y-8 sm:grid-cols-2">
            {CAPABILITIES.map((item) => (
              <div key={item.label} className="border-t border-line/70 pt-4">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  {item.label}
                </p>
                <h3 className="mt-1.5 font-display text-xl font-semibold tracking-tight text-ink">
                  {item.title}
                </h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{item.copy}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="rise-in-delay-1 border-t border-line/70 py-12 md:py-14">
          <div className="grid gap-8 lg:grid-cols-[1.05fr_0.95fr] lg:gap-12 lg:items-start">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-accent">
                GitHub workflow
              </p>
              <h2 className="mt-2 font-display text-2xl font-semibold tracking-tight text-ink md:text-3xl">
                From PR report to a review you actually submit.
              </h2>
              <p className="mt-3 max-w-lg text-sm leading-relaxed text-muted-foreground md:text-base">
                Review Entire PR builds a structured findings report. You curate a draft, edit the
                exact text, preview, then confirm. AI never posts, approves, or requests changes
                alone.
              </p>
            </div>

            <ol className="space-y-0">
              {PR_FLOW.map(([label, detail], index) => (
                <li
                  key={label}
                  className="flex gap-3 border-t border-line/70 py-3 first:border-t-0 first:pt-0 last:pb-0"
                >
                  <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-ink font-display text-[11px] font-bold text-inverse">
                    {index + 1}
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-ink">{label}</p>
                    <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{detail}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="rise-in-delay-2 border-t border-line/70 py-12 md:py-14">
          <div className="grid gap-8 lg:grid-cols-[1.05fr_0.95fr] lg:gap-12 lg:items-start">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-accent">
                Jira workflow
              </p>
              <h2 className="mt-2 font-display text-2xl font-semibold tracking-tight text-ink md:text-3xl">
                From ticket to engineering context — then compare with a PR.
              </h2>
              <p className="mt-3 max-w-lg text-sm leading-relaxed text-muted-foreground md:text-base">
                Connect Jira Cloud once in Settings. On an issue page, Project X summarizes
                requirements, extracts explicit vs inferred acceptance criteria, and can compare
                against a linked GitHub PR. Jira stays read-only.
              </p>
              <p className="mt-4 text-sm text-muted-foreground">
                Setup steps live in{' '}
                <Link
                  href="/app/settings"
                  className="font-semibold text-ink underline-offset-2 hover:underline"
                >
                  Settings → Jira
                </Link>
                .
              </p>
            </div>

            <ol className="space-y-0">
              {JIRA_FLOW.map(([label, detail], index) => (
                <li
                  key={label}
                  className="flex gap-3 border-t border-line/70 py-3 first:border-t-0 first:pt-0 last:pb-0"
                >
                  <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-ink font-display text-[11px] font-bold text-inverse">
                    {index + 1}
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-ink">{label}</p>
                    <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">{detail}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="rise-in-delay-3 border-t border-line/70 py-10 md:py-12">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="max-w-xl">
              <p className="font-display text-xl font-semibold tracking-tight text-ink md:text-2xl">
                Same account for extension, studio, GitHub, and Jira.
              </p>
              <p className="mt-1.5 text-sm text-muted-foreground">
                Connect a GitHub PAT and/or Jira API token in Settings when you need those
                integrations.
              </p>
            </div>
            <Link
              href="/app"
              className="inline-flex shrink-0 rounded-2xl bg-ink px-5 py-2.5 text-sm font-semibold text-inverse transition hover:opacity-90"
            >
              Open the studio
            </Link>
          </div>
        </section>

        <footer className="border-t border-line/70 py-6 text-sm text-muted-foreground">
          {APP_NAME} · Chrome extension + studio
        </footer>
      </div>
    </main>
  );
}
