/**
 * Live benchmark planning: case selection, spending bounds and the dry-run report.
 *
 * Worst-case cost per review comes from the production review limits, which the orchestrator
 * enforces on every review:
 *   batches        ≤ maxInputTokens input (reservations include retries) and
 *                  ≤ maxTotalOutputTokens output
 *   verifications  ≤ maxVerifications calls (no retries), each ≤ verifyInputTokens input and
 *                  ≤ verifyOutputTokens output
 * Input budgets are enforced on a chars/3 estimate and settled with provider usage, so a
 * tokenizer that counts more tokens than the estimate could overshoot by the last request:
 * INPUT_MARGIN covers that. Expected cost uses the token usage of the scripted replay of the
 * same case (real prompt sizes; scripted outputs are short, so expected output is a floor).
 */
import { estimateAiCost, findModelPricing } from '@project-x/shared';

import {
  DEFAULT_PR_REVIEW_LIMITS,
  type PrReviewLimits,
} from '../../../src/ai/pr-review/pr-review-plan';
import type { BenchCase } from '../harness';

export const INPUT_MARGIN = 1.25;
export const MAX_RUNS_PER_CASE = 10;
export const DEFAULT_RUNS_PER_CASE = 3;

export type LiveOptions = {
  cases: string[];
  group: string | null;
  runs: number;
  maxUsd: number | null;
  confirmSpend: string | null;
  model: { provider: string; id: string };
};

/**
 * Reads options from the environment:
 *   BENCH_CASES=a,b      selected case ids        BENCH_GROUP=security   one selection group
 *   BENCH_RUNS=3         runs per case (1–10)     BENCH_MAX_USD=1.00     total spending cap
 *   BENCH_CONFIRM_SPEND  must equal the dry-run "maximum" to run paid calls
 *   BENCH_MODEL_ID       model id (default AI_MODEL, else gpt-4o-mini); provider is openai
 */
export function parseOptions(
  env: Record<string, string | undefined>,
  corpus: BenchCase[],
): { options: LiveOptions; errors: string[] } {
  const errors: string[] = [];
  const ids = new Set(corpus.map((c) => c.id));
  const requested = (env.BENCH_CASES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const id of requested.filter((x) => !ids.has(x))) errors.push(`unknown case "${id}"`);
  const group = env.BENCH_GROUP?.trim() || null;
  const groups = new Set(corpus.flatMap((c) => c.groups));
  if (group && !groups.has(group)) {
    errors.push(`unknown group "${group}" (groups: ${[...groups].sort().join(', ')})`);
  }
  const cases = corpus
    .filter((c) => requested.length === 0 || requested.includes(c.id))
    .filter((c) => !group || c.groups.includes(group))
    .map((c) => c.id);
  if (cases.length === 0 && errors.length === 0) errors.push('the selection matches no case');

  const runs = env.BENCH_RUNS ? Number(env.BENCH_RUNS) : DEFAULT_RUNS_PER_CASE;
  if (!Number.isInteger(runs) || runs < 1 || runs > MAX_RUNS_PER_CASE) {
    errors.push(`BENCH_RUNS must be an integer 1–${MAX_RUNS_PER_CASE}`);
  }
  const maxUsd = env.BENCH_MAX_USD ? Number(env.BENCH_MAX_USD) : null;
  if (maxUsd != null && !(Number.isFinite(maxUsd) && maxUsd > 0)) {
    errors.push('BENCH_MAX_USD must be a positive number');
  }
  return {
    options: {
      cases,
      group,
      runs,
      maxUsd,
      confirmSpend: env.BENCH_CONFIRM_SPEND?.trim() || null,
      model: { provider: 'openai', id: env.BENCH_MODEL_ID || env.AI_MODEL || 'gpt-4o-mini' },
    },
    errors,
  };
}

export type TokenBound = { input: number; output: number; calls: number };

/** Upper bound of the tokens one review can consume under the given limits. */
export function worstCaseTokens(limits: PrReviewLimits = DEFAULT_PR_REVIEW_LIMITS): TokenBound {
  return {
    input: Math.ceil(
      (limits.maxInputTokens + limits.maxVerifications * limits.verifyInputTokens) * INPUT_MARGIN,
    ),
    output: limits.maxTotalOutputTokens + limits.maxVerifications * limits.verifyOutputTokens,
    calls: limits.maxBatches * 2 + limits.maxVerifications,
  };
}

export function priceTokens(
  model: { provider: string; id: string },
  t: { input: number; output: number },
): number | null {
  const cost = estimateAiCost({
    provider: model.provider,
    model: model.id,
    usage: { inputTokens: t.input, outputTokens: t.output, providerReported: false },
  });
  return cost.totalCostUsd ?? null;
}

/** Cents, rounded up: the value BENCH_CONFIRM_SPEND must repeat. */
export const usdCeil = (usd: number) => (Math.ceil(usd * 100 - 1e-9) / 100).toFixed(2);

export type CasePlan = {
  caseId: string;
  groups: string[];
  runs: number;
  expected: TokenBound & { usd: number | null };
  worst: TokenBound & { usd: number | null };
};

export type SpendPlan = {
  model: { provider: string; id: string };
  pricingAvailable: boolean;
  pricingVersion: string | null;
  reviews: number;
  perReviewWorst: TokenBound & { usd: number | null };
  cases: CasePlan[];
  expectedUsd: number | null;
  maxUsd: number | null;
  /** The string BENCH_CONFIRM_SPEND must equal. */
  confirmValue: string | null;
};

export function buildPlan(
  options: LiveOptions,
  corpus: BenchCase[],
  scriptedUsage: Map<string, TokenBound>,
  limits: PrReviewLimits = DEFAULT_PR_REVIEW_LIMITS,
): SpendPlan {
  const pricing = findModelPricing(options.model.provider, options.model.id);
  const worst = worstCaseTokens(limits);
  const worstUsd = priceTokens(options.model, worst);
  const cases = options.cases.map((id) => {
    const c = corpus.find((x) => x.id === id)!;
    const used = scriptedUsage.get(id) ?? worst;
    return {
      caseId: id,
      groups: c.groups,
      runs: options.runs,
      expected: { ...used, usd: priceTokens(options.model, used) },
      worst: { ...worst, usd: worstUsd },
    };
  });
  const reviews = cases.length * options.runs;
  const sum = (f: (c: CasePlan) => number | null) =>
    cases.some((c) => f(c) == null) ? null : cases.reduce((n, c) => n + (f(c) ?? 0) * c.runs, 0);
  const maxUsd = sum((c) => c.worst.usd);
  return {
    model: options.model,
    pricingAvailable: pricing != null,
    pricingVersion: pricing?.pricingVersion ?? null,
    reviews,
    perReviewWorst: { ...worst, usd: worstUsd },
    cases,
    expectedUsd: sum((c) => c.expected.usd),
    maxUsd,
    confirmValue: maxUsd == null ? null : usdCeil(maxUsd),
  };
}

/** Reasons a paid run must not start (empty = allowed). */
export function paidRunBlockers(
  plan: SpendPlan,
  options: LiveOptions,
  env: Record<string, string | undefined>,
): string[] {
  const out: string[] = [];
  if (env.BENCH_LIVE !== '1') out.push('BENCH_LIVE=1 is not set');
  if (!env.OPENAI_API_KEY) out.push('OPENAI_API_KEY is not set');
  if (!plan.pricingAvailable || plan.maxUsd == null) {
    out.push(
      `no pricing for ${plan.model.provider}:${plan.model.id}; the maximum cannot be bounded`,
    );
  }
  if (options.maxUsd == null) out.push('BENCH_MAX_USD (total spending cap) is not set');
  else if (plan.maxUsd != null && plan.maxUsd > options.maxUsd) {
    out.push(
      `planned maximum $${usdCeil(plan.maxUsd)} exceeds BENCH_MAX_USD=$${options.maxUsd}; select fewer cases or runs`,
    );
  }
  if (plan.confirmValue != null && options.confirmSpend !== plan.confirmValue) {
    out.push(`BENCH_CONFIRM_SPEND must equal the dry-run maximum "${plan.confirmValue}"`);
  }
  return out;
}

const money = (v: number | null) => (v == null ? 'unavailable' : `$${v.toFixed(4)}`);

export function renderDryRun(plan: SpendPlan, options: LiveOptions, blockers: string[]): string {
  const rows = plan.cases.map(
    (c) =>
      `| ${c.caseId} | ${c.groups.join(', ')} | ${c.runs} | ${c.expected.input} / ${c.expected.output} | ${money(
        c.expected.usd == null ? null : c.expected.usd * c.runs,
      )} | ${money(c.worst.usd == null ? null : c.worst.usd * c.runs)} |`,
  );
  return [
    '# Live benchmark — dry run',
    '',
    '> **Provenance: dry run.** No model was called. Expected cost uses the token usage of the',
    '> scripted replay of each case; the maximum is the hard bound from the review limits.',
    '',
    `- Model: \`${plan.model.provider}:${plan.model.id}\` (pricing ${plan.pricingAvailable ? `catalog ${plan.pricingVersion}` : '**unavailable**'})`,
    `- Selection: ${options.group ? `group \`${options.group}\`` : 'cases'} → ${plan.cases.length} case(s) × ${options.runs} run(s) = ${plan.reviews} review(s)`,
    `- Worst case per review: ${plan.perReviewWorst.input} input / ${plan.perReviewWorst.output} output tokens, ≤ ${plan.perReviewWorst.calls} calls → ${money(plan.perReviewWorst.usd)} (input ×${INPUT_MARGIN} tokenizer margin)`,
    `- **Expected total: ${money(plan.expectedUsd)}**`,
    `- **Maximum total: ${money(plan.maxUsd)}** — confirm with \`BENCH_CONFIRM_SPEND=${plan.confirmValue ?? 'n/a'}\``,
    `- Spending cap: ${options.maxUsd == null ? 'not set (BENCH_MAX_USD)' : `$${options.maxUsd}`}`,
    `- Usage units: 1 per review (${plan.reviews} total); production AI budgets are not used or changed.`,
    '',
    '| Case | Groups | Runs | Expected tokens in / out (per review) | Expected (all runs) | Maximum (all runs) |',
    '|---|---|---|---|---|---|',
    ...rows,
    '',
    '## Paid execution',
    '',
    blockers.length === 0
      ? 'All preconditions are met.'
      : ['Blocked until:', '', ...blockers.map((b) => `- ${b}`)].join('\n'),
    '',
  ].join('\n');
}
