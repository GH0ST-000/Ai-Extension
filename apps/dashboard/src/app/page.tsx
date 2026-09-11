import Link from 'next/link';

import { APP_NAME } from '@project-x/shared';

import { BrandGlyph } from '../components/brand-mark';
import { LandingHeader } from '../components/landing-header';
import { LandingHeroCtas } from '../components/landing-hero-ctas';
import { LandingProductStage } from '../components/landing-product-stage';

const SIGNALS = [
  {
    label: 'Smart Actions',
    line: 'Menu follows the selection — ranked on-device.',
  },
  {
    label: 'Replace',
    line: 'Write back in place. Locked inputs stay locked.',
  },
  {
    label: 'Errors',
    line: 'Stack classified locally, then Understand / Root Cause / Fix.',
  },
  {
    label: 'Suggest Fix',
    line: 'Minimal patch preview. Never a silent commit.',
  },
] as const;

const ALIGN_NODES = [
  { label: 'Jira', detail: 'Requirement' },
  { label: 'PR', detail: 'Implementation' },
  { label: 'API', detail: 'Contract' },
] as const;

const GUARDS = [
  'Plan approval ≠ write confirmation',
  'No merge · no shell · no Jira writes',
  'OpenAPI is analysis-only',
  'Tokens stay on the API',
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

        <section className="flex min-h-[62vh] flex-col justify-center py-12 md:min-h-[68vh] md:py-14">
          <div className="rise-in-delay-1 max-w-3xl">
            <BrandGlyph size={56} className="mb-5 rounded-[1.15rem] shadow-soft" />
            <p className="mb-3 font-display text-4xl font-semibold tracking-tight text-ink md:text-6xl">
              {APP_NAME}
            </p>
            <h1 className="max-w-2xl font-display text-2xl font-semibold leading-[1.12] tracking-tight text-ink text-balance md:text-4xl">
              AI that reads the page with you.
            </h1>
            <p className="mt-4 max-w-xl text-base leading-relaxed text-muted-foreground md:text-lg">
              One Chrome selection. Five focused tabs. Confirmed GitHub writes only when you say so.
            </p>
            <LandingHeroCtas />
          </div>
        </section>

        <section className="rise-in pb-4 md:pb-6">
          <div className="mb-6 flex flex-col gap-2 md:mb-8 md:flex-row md:items-end md:justify-between">
            <div className="max-w-xl">
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-accent">
                Extension surface
              </p>
              <h2 className="mt-2 font-display text-2xl font-semibold tracking-tight text-ink md:text-3xl">
                Text · GitHub · Jira · API · Flow
              </h2>
            </div>
            <p className="max-w-sm text-sm leading-relaxed text-muted-foreground md:text-right">
              Switch the tab below — same chrome you get in the toolbar.
            </p>
          </div>
          <LandingProductStage />
        </section>

        <section className="rise-in-delay-1 py-14 md:py-16">
          <div className="grid gap-10 lg:grid-cols-[0.9fr_1.1fr] lg:items-center lg:gap-14">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-accent">
                Before the cloud
              </p>
              <h2 className="mt-2 font-display text-2xl font-semibold tracking-tight text-ink md:text-3xl">
                Ranking and redaction stay on the device.
              </h2>
              <p className="mt-3 max-w-md text-sm leading-relaxed text-muted-foreground md:text-base">
                The menu reacts to what you highlighted. Secrets are stripped before anything leaves
                the browser for a model call.
              </p>
            </div>

            <ul className="grid gap-0 sm:grid-cols-2">
              {SIGNALS.map((item, index) => (
                <li
                  key={item.label}
                  className={[
                    'border-line/70 py-4',
                    index % 2 === 0 ? 'sm:pr-6 sm:border-r' : 'sm:pl-6',
                    index < 2 ? 'border-b' : '',
                  ].join(' ')}
                >
                  <p className="font-display text-lg font-semibold tracking-tight text-ink">
                    {item.label}
                  </p>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{item.line}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="rise-in-delay-2 overflow-hidden rounded-[1.75rem] bg-ink px-6 py-10 text-inverse shadow-panel md:px-10 md:py-12">
          <div className="grid gap-10 lg:grid-cols-[1fr_1.05fr] lg:items-center lg:gap-12">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-accent">
                Engineering alignment
              </p>
              <h2 className="mt-2 font-display text-2xl font-semibold tracking-tight text-balance md:text-3xl">
                Three sources. One bounded answer.
              </h2>
              <p className="mt-3 max-w-md text-sm leading-relaxed text-inverse/65 md:text-base">
                When Jira, a PR, and OpenAPI are in session, Project X builds a typed Engineering
                Context — coverage and conflicts with evidence, not vibes.
              </p>
            </div>

            <div className="relative">
              <div
                className="pointer-events-none absolute left-[12%] right-[12%] top-1/2 hidden h-px -translate-y-1/2 bg-gradient-to-r from-transparent via-accent/50 to-transparent sm:block"
                aria-hidden
              />
              <ul className="grid gap-3 sm:grid-cols-3 sm:gap-4">
                {ALIGN_NODES.map((node, index) => (
                  <li
                    key={node.label}
                    className={[
                      'rounded-2xl border border-inverse/10 bg-inverse/5 px-4 py-5 text-center backdrop-blur-sm',
                      index === 1 ? 'sm:-translate-y-2 sm:border-accent/40 sm:bg-accent/10' : '',
                    ].join(' ')}
                  >
                    <p className="font-display text-xl font-semibold tracking-tight">
                      {node.label}
                    </p>
                    <p className="mt-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-inverse/50">
                      {node.detail}
                    </p>
                  </li>
                ))}
              </ul>
              <p className="mt-5 text-center text-sm text-inverse/55">
                Optional CI head · hallucinated paths dropped · stale bindings flagged
              </p>
            </div>
          </div>
        </section>

        <section className="rise-in-delay-3 py-14 md:py-16">
          <div className="max-w-2xl">
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-accent">
              Control plane
            </p>
            <h2 className="mt-2 font-display text-2xl font-semibold tracking-tight text-ink md:text-3xl">
              Autonomy stops where risk starts.
            </h2>
          </div>
          <ul className="mt-8 grid gap-x-10 gap-y-4 sm:grid-cols-2">
            {GUARDS.map((guard) => (
              <li key={guard} className="flex gap-3 text-sm font-medium text-ink">
                <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden />
                <span className="leading-relaxed">{guard}</span>
              </li>
            ))}
          </ul>
          <p className="mt-5 max-w-xl text-sm leading-relaxed text-muted-foreground">
            Flow can plan and adapt. GitHub comment, review submit, and Apply Fix still open the
            exact confirmation UI — plan approval never authorizes a write.
          </p>
        </section>

        <section className="rise-in border-t border-line/70 py-10 md:py-12">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="max-w-xl">
              <p className="font-display text-xl font-semibold tracking-tight text-ink md:text-2xl">
                Same account for extension, studio, GitHub, and Jira.
              </p>
              <p className="mt-1.5 text-sm text-muted-foreground">
                Connect tokens in Settings. OpenAPI and Flow light up once you are signed in.
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
