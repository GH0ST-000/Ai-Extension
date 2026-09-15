'use client';

import { useCallback, useId, useState, type KeyboardEvent } from 'react';

type DemoStepId = 'review' | 'findings' | 'suggest' | 'preview' | 'confirm';

type DemoStep = {
  id: DemoStepId;
  label: string;
  title: string;
  detail: string;
};

const STEPS: readonly DemoStep[] = [
  {
    id: 'review',
    label: 'PR Review',
    title: 'Review the open pull request',
    detail:
      'Project X reads the PR already on the page — files, diff, and discussion — without pasting context into another chat.',
  },
  {
    id: 'findings',
    label: 'Findings',
    title: '3 findings worth your attention',
    detail:
      'Structured issues you can keep, ignore, or turn into a fix — not a wall of raw model text.',
  },
  {
    id: 'suggest',
    label: 'Suggest Fix',
    title: 'Propose a minimal patch',
    detail:
      'Pick a finding and generate a focused change. Nothing leaves draft form until you ask for a preview.',
  },
  {
    id: 'preview',
    label: 'Patch Preview',
    title: 'Inspect the exact diff',
    detail: 'See the files and lines that would change before any write reaches GitHub.',
  },
  {
    id: 'confirm',
    label: 'Confirm',
    title: 'Nothing is written until you confirm',
    detail:
      'Apply Fix opens the same confirmation UI used in the product. Cancel leaves GitHub untouched.',
  },
] as const;

const FINDINGS = [
  {
    id: 'f1',
    severity: 'High',
    title: 'Null user on checkout path',
    file: 'src/services/user.ts',
  },
  {
    id: 'f2',
    severity: 'Medium',
    title: 'Missing auth check on admin route',
    file: 'src/routes/admin.ts',
  },
  {
    id: 'f3',
    severity: 'Low',
    title: 'Stale cache key after profile update',
    file: 'src/cache/profile.ts',
  },
] as const;

export function LandingWorkflowDemo() {
  const baseId = useId();
  const [stepIndex, setStepIndex] = useState(0);
  const [selectedFinding, setSelectedFinding] = useState(0);
  const step = STEPS[stepIndex]!;

  const goTo = useCallback((index: number) => {
    setStepIndex(Math.max(0, Math.min(STEPS.length - 1, index)));
  }, []);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
        event.preventDefault();
        goTo(stepIndex + 1);
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        event.preventDefault();
        goTo(stepIndex - 1);
      } else if (event.key === 'Home') {
        event.preventDefault();
        goTo(0);
      } else if (event.key === 'End') {
        event.preventDefault();
        goTo(STEPS.length - 1);
      }
    },
    [goTo, stepIndex],
  );

  return (
    <div className="relative overflow-hidden rounded-[1.75rem] border border-line/80 bg-panel/70 shadow-panel">
      <div
        className="pointer-events-none absolute inset-0 bg-gradient-to-br from-accent/20 via-transparent to-spark/15 opacity-90"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute -left-12 bottom-0 h-40 w-40 rounded-full bg-spark/15 blur-3xl"
        aria-hidden
      />

      <div className="relative border-b border-line/70 bg-panel/55 px-4 py-3 backdrop-blur-md sm:px-5">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-accent">
              Product walkthrough
            </p>
            <p className="mt-1 font-display text-lg font-semibold tracking-tight text-ink sm:text-xl">
              GitHub PR → review → fix → confirm
            </p>
          </div>
          <p className="text-xs text-muted-foreground sm:max-w-xs sm:text-right">
            Local demo only — no AI, GitHub, or writes.
          </p>
        </div>
      </div>

      <div
        className="relative grid gap-0 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]"
        onKeyDown={onKeyDown}
      >
        <nav
          className="border-b border-line/70 p-3 sm:p-4 lg:border-b-0 lg:border-r"
          aria-label="Workflow steps"
        >
          <ol className="flex gap-2 overflow-x-auto pb-1 lg:flex-col lg:gap-1 lg:overflow-visible lg:pb-0 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {STEPS.map((item, index) => {
              const selected = index === stepIndex;
              return (
                <li key={item.id} className="shrink-0 lg:shrink">
                  <button
                    type="button"
                    id={`${baseId}-tab-${item.id}`}
                    aria-controls={`${baseId}-panel`}
                    aria-current={selected ? 'step' : undefined}
                    onClick={() => goTo(index)}
                    className={[
                      'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition',
                      selected
                        ? 'bg-ink text-inverse shadow-soft'
                        : 'text-muted-foreground hover:bg-muted/80 hover:text-ink',
                    ].join(' ')}
                  >
                    <span
                      className={[
                        'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[11px] font-semibold',
                        selected ? 'bg-inverse/15 text-inverse' : 'bg-mist text-ink/50',
                      ].join(' ')}
                    >
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold tracking-tight">
                        {item.label}
                      </span>
                      <span
                        className={[
                          'mt-0.5 hidden text-[11px] leading-snug lg:block',
                          selected ? 'text-inverse/65' : 'text-muted-foreground',
                        ].join(' ')}
                      >
                        {item.title}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        <div
          id={`${baseId}-panel`}
          role="region"
          aria-labelledby={`${baseId}-tab-${step.id}`}
          className="landing-stage-in p-4 sm:p-5 md:p-6"
          key={step.id}
        >
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-accent">
            {step.label}
          </p>
          <h3 className="mt-2 font-display text-xl font-semibold tracking-tight text-ink text-balance md:text-2xl">
            {step.title}
          </h3>
          <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">
            {step.detail}
          </p>

          <div className="mt-5 rounded-2xl border border-line/80 bg-mist/60 p-3 sm:p-4">
            {step.id === 'review' ? <ReviewPane /> : null}
            {step.id === 'findings' ? (
              <FindingsPane
                selected={selectedFinding}
                onSelect={setSelectedFinding}
                baseId={baseId}
              />
            ) : null}
            {step.id === 'suggest' ? (
              <SuggestPane finding={FINDINGS[selectedFinding] ?? FINDINGS[0]!} />
            ) : null}
            {step.id === 'preview' ? <PreviewPane /> : null}
            {step.id === 'confirm' ? <ConfirmPane /> : null}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={stepIndex === 0}
              onClick={() => goTo(stepIndex - 1)}
              className="rounded-xl border border-line bg-panel/80 px-3.5 py-2 text-sm font-semibold text-ink transition hover:bg-panel disabled:cursor-not-allowed disabled:opacity-40"
            >
              Back
            </button>
            <button
              type="button"
              disabled={stepIndex === STEPS.length - 1}
              onClick={() => goTo(stepIndex + 1)}
              className="rounded-xl bg-ink px-3.5 py-2 text-sm font-semibold text-inverse transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Next
            </button>
            <p className="ml-auto text-[11px] text-muted-foreground">
              Step {stepIndex + 1} of {STEPS.length}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function ReviewPane() {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="rounded-lg bg-ink px-2 py-1 font-semibold text-inverse">PR #482</span>
        <span className="font-medium text-ink">fix: null-safe checkout user</span>
      </div>
      <ul className="space-y-2 text-sm text-muted-foreground">
        <li className="flex justify-between gap-3 border-b border-line/50 py-2">
          <span className="font-mono text-[12px] text-ink">src/services/user.ts</span>
          <span className="shrink-0 text-accent">+18 −4</span>
        </li>
        <li className="flex justify-between gap-3 border-b border-line/50 py-2">
          <span className="font-mono text-[12px] text-ink">src/routes/checkout.ts</span>
          <span className="shrink-0 text-accent">+9 −2</span>
        </li>
        <li className="flex justify-between gap-3 py-2">
          <span className="font-mono text-[12px] text-ink">tests/checkout.spec.ts</span>
          <span className="shrink-0 text-accent">+22 −0</span>
        </li>
      </ul>
    </div>
  );
}

function FindingsPane({
  selected,
  onSelect,
  baseId,
}: {
  selected: number;
  onSelect: (index: number) => void;
  baseId: string;
}) {
  return (
    <ul className="space-y-2" aria-label="Sample findings">
      {FINDINGS.map((finding, index) => {
        const active = index === selected;
        return (
          <li key={finding.id}>
            <button
              type="button"
              id={`${baseId}-finding-${finding.id}`}
              aria-pressed={active}
              onClick={() => onSelect(index)}
              className={[
                'flex w-full flex-col gap-1 rounded-xl border px-3 py-2.5 text-left transition sm:flex-row sm:items-center sm:justify-between',
                active
                  ? 'border-accent/50 bg-accent-soft/60'
                  : 'border-line/70 bg-panel/50 hover:border-line',
              ].join(' ')}
            >
              <div className="min-w-0">
                <p className="text-sm font-semibold text-ink">{finding.title}</p>
                <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{finding.file}</p>
              </div>
              <span className="shrink-0 self-start rounded-lg border border-line bg-mist px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground sm:self-auto">
                {finding.severity}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function SuggestPane({ finding }: { finding: (typeof FINDINGS)[number] }) {
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">
        Selected finding: <span className="font-semibold text-ink">{finding.title}</span>
      </p>
      <div className="rounded-xl border border-line/70 bg-panel/70 px-3 py-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-accent">
          Suggested approach
        </p>
        <p className="mt-2 leading-relaxed text-ink">
          Guard the checkout path when{' '}
          <code className="rounded bg-mist px-1 py-0.5 text-[12px]">user</code> is null, return a
          typed error, and cover it with a unit test.
        </p>
      </div>
    </div>
  );
}

function PreviewPane() {
  return (
    <div className="overflow-hidden rounded-xl border border-line/70 bg-panel/80 font-mono text-[12px] leading-relaxed">
      <div className="flex items-center justify-between border-b border-line/70 bg-mist/70 px-3 py-2">
        <span className="font-semibold text-ink">src/services/user.ts</span>
        <span className="text-accent">+12 −4</span>
      </div>
      <pre className="overflow-x-auto p-3 text-muted-foreground">
        <code>
          <span className="block text-red-600/90 dark:text-red-400/90">
            - return user.profile.email;
          </span>
          <span className="block text-emerald-700 dark:text-emerald-400">+ if (!user) {'{'}</span>
          <span className="block text-emerald-700 dark:text-emerald-400">
            + throw new CheckoutError(&apos;USER_REQUIRED&apos;);
          </span>
          <span className="block text-emerald-700 dark:text-emerald-400">+ {'}'}</span>
          <span className="block text-emerald-700 dark:text-emerald-400">
            + return user.profile.email;
          </span>
        </code>
      </pre>
    </div>
  );
}

function ConfirmPane() {
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-line/70 bg-panel/80 px-3 py-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-ink">Generated patch</p>
            <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
              src/services/user.ts · +12 −4
            </p>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap gap-2" aria-hidden>
          <span className="rounded-xl border border-line bg-panel px-3.5 py-2 text-sm font-semibold text-ink">
            Cancel
          </span>
          <span className="rounded-xl bg-accent px-3.5 py-2 text-sm font-semibold text-accent-foreground">
            Apply Fix
          </span>
        </div>
      </div>
      <p className="text-sm font-medium text-ink">
        <span
          className="mr-2 inline-block h-1.5 w-1.5 rounded-full bg-accent align-middle"
          aria-hidden
        />
        Nothing is written until you confirm.
      </p>
    </div>
  );
}
