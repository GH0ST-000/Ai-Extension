'use client';

import { useEffect, useId, useRef, useState } from 'react';

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
    title: 'Highlight → ranked menu → act.',
    copy: 'Select text or code on any page. Project X ranks useful actions locally, then streams an answer — or replaces the selection in place when the field is safe.',
    rail: [
      { label: 'Explain', detail: 'Understand selected code or prose' },
      { label: 'Improve', detail: 'Tighten writing or clarity' },
      { label: 'Errors', detail: 'Classify stacks, then root-cause or fix' },
      { label: 'Replace', detail: 'Write back only into editable fields' },
    ],
    accent: 'from-accent/25 via-transparent to-spark/20',
  },
  {
    id: 'github',
    tab: 'GitHub',
    eyebrow: 'Pull requests',
    title: 'Review → findings → you confirm the write.',
    copy: 'Turn a PR into structured findings, a curated review draft, CI insight, and a patch preview. Comments, review submit, and Apply Fix always wait for your confirmation.',
    rail: [
      { label: 'PR Review', detail: 'Multi-file findings you can curate' },
      { label: 'Suggest Fix', detail: 'Minimal patch from a finding' },
      { label: 'CI Failures', detail: 'Understand broken checks in context' },
      { label: 'Confirm', detail: 'Exact preview — never a silent post' },
    ],
    accent: 'from-ink/10 via-transparent to-accent/20',
  },
  {
    id: 'jira',
    tab: 'Jira',
    eyebrow: 'Requirements',
    title: 'Understand the ticket. Never write back.',
    copy: 'Summarize the issue, pull acceptance criteria, sketch a technical plan, and compare the requirement with a linked PR. Jira stays read-only.',
    rail: [
      { label: 'Summarize', detail: 'Issue intent in plain language' },
      { label: 'Criteria', detail: 'Extract what “done” means' },
      { label: 'Plan', detail: 'Technical approach and risks' },
      { label: 'Align', detail: 'Requirement vs PR coverage' },
    ],
    accent: 'from-spark/20 via-transparent to-accent/15',
  },
  {
    id: 'api',
    tab: 'API',
    eyebrow: 'OpenAPI · Swagger',
    title: 'Read the contract. Never call it.',
    copy: 'Explain endpoints, request/response shapes, examples, and contract risks. Analysis only — no Try It, no credentials, no live execution.',
    rail: [
      { label: 'Explain', detail: 'Method, path, and payload shapes' },
      { label: 'Examples', detail: 'Synthetic request/response samples' },
      { label: 'Risks', detail: 'Auth, breaking changes, gaps' },
      { label: 'Compare', detail: 'Contract vs implementation signals' },
    ],
    accent: 'from-accent/30 via-transparent to-ink/5',
  },
  {
    id: 'flow',
    tab: 'Flow',
    eyebrow: 'Workflow',
    title: 'Goal → smallest safe plan → you approve.',
    copy: 'Describe what you want. Project X proposes a short plan, can run safe read-only steps, adapts when context changes, and always pauses before anything writes.',
    rail: [
      { label: 'Goal', detail: 'Tell Project X what to accomplish' },
      { label: 'Plan', detail: 'Smallest safe sequence of steps' },
      { label: 'Adapt', detail: 'Adjust when the page context shifts' },
      { label: 'Confirm', detail: 'Writes stay under your control' },
    ],
    accent: 'from-spark/25 via-transparent to-accent/25',
  },
] as const;

export function LandingProductStage() {
  const [active, setActive] = useState<StageId>('github');
  const baseId = useId();
  const tabRefs = useRef<Partial<Record<StageId, HTMLButtonElement | null>>>({});
  const focusAfterNav = useRef(false);
  const stage = STAGES.find((s) => s.id === active) ?? STAGES[1]!;

  useEffect(() => {
    if (!focusAfterNav.current) return;
    focusAfterNav.current = false;
    tabRefs.current[active]?.focus();
  }, [active]);

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
                ref={(node) => {
                  tabRefs.current[item.id] = node;
                }}
                aria-selected={selected}
                aria-controls={`${baseId}-panel`}
                tabIndex={selected ? 0 : -1}
                onClick={() => setActive(item.id)}
                onKeyDown={(event) => {
                  const order = STAGES.map((s) => s.id);
                  const idx = order.indexOf(active);
                  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                    event.preventDefault();
                    focusAfterNav.current = true;
                    setActive(order[(idx + 1) % order.length]!);
                  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                    event.preventDefault();
                    focusAfterNav.current = true;
                    setActive(order[(idx - 1 + order.length) % order.length]!);
                  } else if (event.key === 'Home') {
                    event.preventDefault();
                    focusAfterNav.current = true;
                    setActive(order[0]!);
                  } else if (event.key === 'End') {
                    event.preventDefault();
                    focusAfterNav.current = true;
                    setActive(order[order.length - 1]!);
                  }
                }}
                className={[
                  'shrink-0 rounded-xl px-3 py-1.5 text-[12px] font-semibold tracking-wide transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50',
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
