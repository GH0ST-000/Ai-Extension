import Link from 'next/link';

import { HealthCheckButton } from '../../components/health-check-button';

const CAPABILITIES = [
  {
    label: 'Smart Actions',
    value: 'Ranked for the selection',
    copy: 'Code, errors, prose, and short text reorder Explain, Summarize, Code Review, and the rest — instantly, on-device.',
  },
  {
    label: 'Replace',
    value: 'Write back in place',
    copy: 'On textareas, text inputs, and contenteditable, stream a rewrite then Replace without leaving the page.',
  },
  {
    label: 'GitHub',
    value: 'Review with confirmation',
    copy: 'PR report → curated Review Draft → COMMENT / APPROVE / REQUEST_CHANGES. Your PAT stays encrypted on the API.',
  },
] as const;

const FLOW_STEPS = [
  'Highlight text, code, an error, or a PR diff',
  'Pick a smart-ranked action (or press A / R / F…)',
  'Stream the answer — Copy, Replace, or confirm a GitHub write',
] as const;

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
          Extension studio
        </p>
        <h1 className="mt-3 max-w-2xl font-display text-4xl font-semibold tracking-tight text-ink text-balance md:text-5xl">
          Smart actions, PR reports, and confirmed GitHub reviews.
        </h1>
        <p className="mt-4 max-w-xl text-base leading-relaxed text-muted-foreground md:text-lg">
          Sign in here to tune response length, page context, and your GitHub token. The extension
          uses the same account for Ask AI, ranking, and safe writes.
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
        {CAPABILITIES.map((item) => (
          <div
            key={item.label}
            className="rounded-3xl border border-line/80 bg-panel/70 p-5 shadow-panel"
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

      <section className="rise-in-delay-2 overflow-hidden rounded-3xl border border-ink bg-ink text-inverse">
        <div className="grid md:grid-cols-[1.2fr_0.8fr]">
          <div className="p-7 md:p-9">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-accent">Flow</p>
            <h2 className="mt-3 font-display text-3xl font-semibold tracking-tight text-balance">
              Select → ranked menu → stream → Replace when you can.
            </h2>
            <p className="mt-3 max-w-lg text-sm leading-relaxed text-inverse/65">
              Works on docs, forms, and GitHub pull requests. Context stays in the extension; OpenAI
              keys never leave the API.
            </p>
          </div>
          <div className="relative border-t border-inverse/10 p-7 md:border-l md:border-t-0 md:p-9">
            <ol className="space-y-4 text-sm">
              {FLOW_STEPS.map((step, index) => (
                <li key={step} className="flex gap-3">
                  <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-inverse/10 font-display text-xs font-bold text-spark">
                    {index + 1}
                  </span>
                  <span className="leading-relaxed text-inverse/80">{step}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </section>

      <section className="rise-in-delay-3 rounded-3xl border border-line bg-panel/70 p-6 shadow-panel md:p-7">
        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          Actions available
        </p>
        <p className="mt-2 font-display text-xl font-semibold tracking-tight text-ink">
          Explain · Improve Writing · Summarize · Translate · Explain Code · Code Review · Suggest
          Fix · Review Entire PR · Understand Error · Find Root Cause · Custom
        </p>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Shortcuts stay bound to each action even when Smart Actions reorders the menu. GitHub
          comment and review submit are confirmed writes — not AI actions.
        </p>
      </section>
    </div>
  );
}
