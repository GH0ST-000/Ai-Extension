import Link from 'next/link';

import { HealthCheckButton } from '../../components/health-check-button';

export default function DashboardHomePage() {
  return (
    <div className="space-y-8">
      <section className="rise-in panel-glass relative overflow-hidden rounded-3xl p-7 shadow-panel md:p-10">
        <div
          className="pointer-events-none absolute -right-10 -top-16 h-56 w-56 rounded-full bg-accent/20 blur-3xl"
          aria-hidden
        />
        <div
          className="pointer-events-none absolute bottom-0 left-1/3 h-40 w-40 rounded-full bg-spark/15 blur-3xl"
          aria-hidden
        />

        <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-accent">
          Today in Project X
        </p>
        <h1 className="mt-3 max-w-2xl font-display text-4xl font-semibold tracking-tight text-ink text-balance md:text-5xl">
          Your AI workspace for the open web.
        </h1>
        <p className="mt-4 max-w-xl text-base leading-relaxed text-muted-foreground md:text-lg">
          The extension already streams answers with page context. This studio is where preferences,
          history, and teams will live — designed to feel calm and sharp.
        </p>

        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            href="/app/settings"
            className="rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-accent-foreground shadow-soft transition hover:brightness-110"
          >
            Open settings
          </Link>
          <HealthCheckButton />
        </div>
      </section>

      <section className="rise-in-delay-1 grid gap-4 md:grid-cols-3">
        {[
          {
            label: 'Context',
            value: 'Generic + GitHub',
            copy: 'Selected text arrives with URL, title, and surrounding code when it matters.',
          },
          {
            label: 'Streaming',
            value: 'Live in-panel',
            copy: 'Answers appear in the same floating container — no new tabs, no popouts.',
          },
          {
            label: 'Studio',
            value: 'Account ready',
            copy: 'Sign in once — settings sync to every Ask AI request from the extension.',
          },
        ].map((item) => (
          <div
            key={item.label}
            className="rounded-3xl border border-line/80 bg-white/70 p-5 shadow-panel"
          >
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              {item.label}
            </p>
            <p className="mt-3 font-display text-2xl font-semibold tracking-tight text-ink">
              {item.value}
            </p>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{item.copy}</p>
          </div>
        ))}
      </section>

      <section className="rise-in-delay-2 overflow-hidden rounded-3xl border border-ink bg-ink text-white">
        <div className="grid md:grid-cols-[1.2fr_0.8fr]">
          <div className="p-7 md:p-9">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-accent">Flow</p>
            <h2 className="mt-3 font-display text-3xl font-semibold tracking-tight text-balance">
              Select → Ask AI → Stream → Stay on the page.
            </h2>
            <p className="mt-3 max-w-lg text-sm leading-relaxed text-white/65">
              Project X keeps the interaction inside the browser surface you already use — GitHub,
              docs, and everyday pages.
            </p>
          </div>
          <div className="relative border-t border-white/10 p-7 md:border-l md:border-t-0 md:p-9">
            <ol className="space-y-4 text-sm">
              {[
                'Highlight any passage or code',
                'Pick Explain, Summarize, or Custom',
                'Watch context-aware tokens stream in',
              ].map((step, index) => (
                <li key={step} className="flex gap-3">
                  <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-white/10 font-display text-xs font-bold text-spark">
                    {index + 1}
                  </span>
                  <span className="leading-relaxed text-white/80">{step}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </section>
    </div>
  );
}
