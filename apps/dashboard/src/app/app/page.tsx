import Link from 'next/link';

import { HealthCheckButton } from '../../components/health-check-button';
import { OnboardingChecklist } from '../../components/onboarding-checklist';

const CAPABILITIES = [
  {
    label: 'Ask AI',
    value: 'Selected text, ranked actions',
    copy: 'Explain, summarize, improve writing, review code, and more — ranked on-device for what you selected.',
  },
  {
    label: 'GitHub',
    value: 'Review with confirmation',
    copy: 'Review PRs, analyze CI, suggest fixes, and post comments or apply patches only after you confirm.',
  },
  {
    label: 'Jira',
    value: 'Issue intelligence',
    copy: 'Summarize issues, extract acceptance criteria, plan work, and compare with a PR. Read-only.',
  },
  {
    label: 'API contracts',
    value: 'OpenAPI / Swagger',
    copy: 'Explain endpoints, generate examples, and surface contract risks — never execute the documented API.',
  },
  {
    label: 'Requirement alignment',
    value: 'Covered · Partial · Not evident',
    copy: 'Compare requirements with PR and API context. Evidence stays scoped to what Project X can see.',
  },
  {
    label: 'Developer workflows',
    value: 'Plan first, then confirm writes',
    copy: 'Approve a plan before multi-step analysis. GitHub writes still need explicit confirmation.',
  },
] as const;

const FLOW_STEPS = [
  'Select text, or open a PR, Jira issue, or API docs page',
  'Choose a relevant action — Ask AI ranks the useful ones first',
  'Review the result. Writes only happen after you confirm',
] as const;

export default function DashboardHomePage() {
  return (
    <div className="space-y-8">
      <OnboardingChecklist />

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
          Project X
        </p>
        <h1 className="mt-3 max-w-2xl font-display text-4xl font-semibold tracking-tight text-ink text-balance md:text-5xl">
          Understand, review, and act where you work.
        </h1>
        <p className="mt-4 max-w-xl text-base leading-relaxed text-muted-foreground md:text-lg">
          Use the Chrome extension for Ask AI on any page. Connect GitHub here for PR reviews, CI
          analysis, and confirmed writes. The extension and dashboard share the same account.
        </p>

        <div className="mt-8 flex flex-wrap gap-3">
          <Link
            href="/app/settings"
            className="rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-accent-foreground shadow-soft transition hover:brightness-110"
          >
            Connect GitHub
          </Link>
          <Link
            href="/app/billing"
            className="rounded-xl border border-line bg-panel/80 px-4 py-2.5 text-sm font-semibold text-ink transition hover:bg-mist"
          >
            Plan & usage
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
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-accent">
              First value
            </p>
            <h2 className="mt-3 font-display text-3xl font-semibold tracking-tight text-balance">
              Select text → Ask AI → or open a PR and Review.
            </h2>
            <p className="mt-3 max-w-lg text-sm leading-relaxed text-inverse/65">
              GitHub is optional for selected-text actions. Project X never posts or changes code
              without your confirmation.
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
    </div>
  );
}
