'use client';

import { useId, useState } from 'react';

type StageId = 'text' | 'github' | 'jira' | 'api' | 'flow';

type Stage = {
  id: StageId;
  tab: string;
  eyebrow: string;
  title: string;
  copy: string;
  rail: ReadonlyArray<{ label: string; detail: string }>;
  accent: string;
};

const STAGES: readonly Stage[] = [
  {
    id: 'text',
    tab: 'Text',
    eyebrow: 'On the page',
    title: 'Highlight → ranked menu → stream.',
    copy: 'Smart Actions reorder locally. Replace writes back into safe fields. Errors classify on-device before any model call.',
    rail: [
      { label: 'Rank', detail: 'Code, errors, prose — no extra model hop' },
      { label: 'Ask', detail: 'Explain · Summarize · Review · Fix' },
      { label: 'Replace', detail: 'In-place, never into passwords' },
      { label: 'Patch', detail: 'Suggest Fix with a confirmable preview' },
    ],
    accent: 'from-accent/25 via-transparent to-spark/20',
  },
  {
    id: 'github',
    tab: 'GitHub',
    eyebrow: 'Pull requests',
    title: 'Report → draft → you confirm the write.',
    copy: 'Structured findings, curated Review Draft, then COMMENT / APPROVE / REQUEST_CHANGES only after preview. CI and Apply Fix share the same rule.',
    rail: [
      { label: 'Review', detail: 'Bounded multi-file PR report' },
      { label: 'Curate', detail: 'Ignore noise; keep what matters' },
      { label: 'Confirm', detail: 'Exact text — never silent post' },
      { label: 'Submit', detail: 'Encrypted PAT · idempotent' },
    ],
    accent: 'from-ink/10 via-transparent to-accent/20',
  },
  {
    id: 'jira',
    tab: 'Jira',
    eyebrow: 'Requirements',
    title: 'Ticket context without writing back.',
    copy: 'Summarize, acceptance criteria, technical plan, risks — then compare with a linked PR. Token stays on the API. Jira stays read-only.',
    rail: [
      { label: 'Connect', detail: 'Email + token · encrypted on API' },
      { label: 'Open', detail: 'Issue page detection' },
      { label: 'Understand', detail: 'Summary · criteria · risks' },
      { label: 'Compare', detail: 'Requirement vs PR diff' },
    ],
    accent: 'from-spark/20 via-transparent to-accent/15',
  },
  {
    id: 'api',
    tab: 'API',
    eyebrow: 'OpenAPI · Swagger',
    title: 'Read the contract. Never call it.',
    copy: 'Safe discovery, endpoint list, synthetic examples, contract risks. No Try It, no credentials, no curl execution.',
    rail: [
      { label: 'Detect', detail: 'Swagger · Redoc · raw spec' },
      { label: 'Select', detail: 'Method + path from a list' },
      { label: 'Explain', detail: 'Shapes · examples · risks' },
      { label: 'Bridge', detail: 'Jira or PR that touches the spec' },
    ],
    accent: 'from-accent/30 via-transparent to-ink/5',
  },
  {
    id: 'flow',
    tab: 'Flow',
    eyebrow: 'Agent plan',
    title: 'Goal → smallest safe plan → you approve.',
    copy: 'Adaptive planning with allowlisted capabilities. Read-only can run after plan approval. Every GitHub write still pauses for Day 12 / 13 / 14 confirmation.',
    rail: [
      { label: 'Goal', detail: 'What you want, in plain language' },
      { label: 'Plan', detail: 'Bounded catalog steps only' },
      { label: 'Adapt', detail: 'Branches + revised plans when needed' },
      { label: 'Confirm', detail: 'Writes never auto-execute' },
    ],
    accent: 'from-spark/25 via-transparent to-accent/25',
  },
] as const;

export function LandingProductStage() {
  const [active, setActive] = useState<StageId>('flow');
  const baseId = useId();
  const stage = STAGES.find((s) => s.id === active) ?? STAGES[4]!;

  return (
    <div className="relative overflow-hidden rounded-[1.75rem] border border-line/80 bg-panel/70 shadow-panel">
      <div
        className={`pointer-events-none absolute inset-0 bg-gradient-to-br ${stage.accent} opacity-90 transition-opacity duration-500`}
        aria-hidden
      />
      <div
        className="pointer-events-none absolute -right-16 top-10 h-48 w-48 rounded-full bg-accent/20 blur-3xl"
        aria-hidden
      />

      <div className="relative border-b border-line/70 bg-panel/55 px-3 py-2.5 backdrop-blur-md sm:px-4">
        <div
          className="flex gap-1 overflow-x-auto pb-0.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          role="tablist"
          aria-label="Extension tabs"
        >
          {STAGES.map((item) => {
            const selected = item.id === active;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                id={`${baseId}-${item.id}`}
                aria-selected={selected}
                aria-controls={`${baseId}-panel`}
                onClick={() => setActive(item.id)}
                className={[
                  'shrink-0 rounded-xl px-3 py-1.5 text-[12px] font-semibold tracking-wide transition',
                  selected
                    ? 'bg-ink text-inverse shadow-soft'
                    : 'text-muted-foreground hover:bg-muted/80 hover:text-ink',
                ].join(' ')}
              >
                {item.tab}
              </button>
            );
          })}
        </div>
      </div>

      <div
        id={`${baseId}-panel`}
        role="tabpanel"
        aria-labelledby={`${baseId}-${stage.id}`}
        className="relative grid gap-8 p-5 sm:p-7 lg:grid-cols-[1.05fr_0.95fr] lg:items-end lg:gap-10"
        key={stage.id}
      >
        <div className="landing-stage-in max-w-xl">
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-accent">
            {stage.eyebrow}
          </p>
          <h3 className="mt-2 font-display text-2xl font-semibold tracking-tight text-ink text-balance md:text-3xl">
            {stage.title}
          </h3>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground md:text-base">
            {stage.copy}
          </p>
        </div>

        <ol className="landing-stage-in-delay grid gap-0 sm:grid-cols-2 lg:grid-cols-1">
          {stage.rail.map((step, index) => (
            <li
              key={step.label}
              className="group relative flex gap-3 border-t border-line/60 py-3 first:border-t-0 first:pt-0 sm:border-t-0 sm:py-2.5 lg:border-t lg:border-line/60 lg:py-3 lg:first:border-t-0 lg:first:pt-0"
            >
              <span className="mt-0.5 font-display text-2xl font-semibold leading-none text-ink/15 transition group-hover:text-accent/50">
                {String(index + 1).padStart(2, '0')}
              </span>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-ink">{step.label}</p>
                <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">
                  {step.detail}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
