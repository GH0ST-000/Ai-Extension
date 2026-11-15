/**
 * Live benchmark planning and dry run. Never contacts a model.
 *
 *   BENCH_DRY_RUN=1 [BENCH_CASES=a,b | BENCH_GROUP=security] [BENCH_RUNS=3] [BENCH_MAX_USD=1]
 *     → prints the plan and writes test/benchmark/out/live-dry-run.md
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_PR_REVIEW_LIMITS } from '../../../src/ai/pr-review/pr-review-plan';
import { BENCH_DIR, loadCorpus, runCase } from '../harness';
import { computeRunSetMetrics, renderRunSetReport, type RunSet } from '../metrics';
import {
  buildPlan,
  INPUT_MARGIN,
  paidRunBlockers,
  parseOptions,
  renderDryRun,
  usdCeil,
  worstCaseTokens,
  type TokenBound,
} from './plan';

const generateTextMock = vi.fn();
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateText: (...args: unknown[]) => generateTextMock(...args) };
});

const corpus = loadCorpus();

/** Token usage of the scripted baseline replay of each case (real prompt sizes). */
async function scriptedUsage(ids: string[]): Promise<Map<string, TokenBound>> {
  const out = new Map<string, TokenBound>();
  for (const id of ids) {
    const r = await runCase(
      corpus.find((c) => c.id === id)!,
      'baseline',
      generateTextMock,
    );
    if (r) out.set(id, { input: r.tokens.input, output: r.tokens.output, calls: r.tokens.calls });
  }
  return out;
}

describe('live benchmark plan (no model calls)', () => {
  it('worst case per review is the bound enforced by the review limits', () => {
    const l = DEFAULT_PR_REVIEW_LIMITS;
    expect(worstCaseTokens()).toEqual({
      input: Math.ceil(
        (l.maxInputTokens + l.maxVerifications * l.verifyInputTokens) * INPUT_MARGIN,
      ),
      output: l.maxTotalOutputTokens + l.maxVerifications * l.verifyOutputTokens,
      calls: l.maxBatches * 2 + l.maxVerifications,
    });
  });

  it('selects one case, a group, or the full corpus, with runs per case', () => {
    const one = parseOptions({ BENCH_CASES: 'request-body-userid', BENCH_RUNS: '5' }, corpus);
    expect(one.errors).toEqual([]);
    expect(one.options).toMatchObject({ cases: ['request-body-userid'], runs: 5 });

    const group = parseOptions({ BENCH_GROUP: 'security' }, corpus);
    expect(group.errors).toEqual([]);
    expect(group.options.cases).toContain('request-body-userid');
    expect(group.options.cases).not.toContain('clean-refactor');
    expect(group.options.runs).toBe(3);

    expect(parseOptions({}, corpus).options.cases).toHaveLength(corpus.length);
    expect(parseOptions({ BENCH_CASES: 'nope' }, corpus).errors).toEqual(['unknown case "nope"']);
    expect(parseOptions({ BENCH_GROUP: 'nope' }, corpus).errors[0]).toMatch(/unknown group/);
    expect(parseOptions({ BENCH_RUNS: '0' }, corpus).errors[0]).toMatch(/BENCH_RUNS/);
    expect(parseOptions({ BENCH_RUNS: '11' }, corpus).errors[0]).toMatch(/BENCH_RUNS/);
    expect(parseOptions({ BENCH_MAX_USD: '-1' }, corpus).errors[0]).toMatch(/BENCH_MAX_USD/);
  });

  it('paid execution requires opt-in, a key, a sufficient cap and the exact confirmation', async () => {
    const env = { BENCH_CASES: 'request-body-userid,request-principal-userid', BENCH_RUNS: '3' };
    const { options } = parseOptions(env, corpus);
    const plan = buildPlan(options, corpus, await scriptedUsage(options.cases));
    expect(plan.reviews).toBe(6);
    expect(plan.maxUsd).toBeCloseTo(plan.perReviewWorst.usd! * 6, 10);
    expect(plan.expectedUsd!).toBeLessThan(plan.maxUsd!);

    expect(paidRunBlockers(plan, options, env)).toEqual([
      'BENCH_LIVE=1 is not set',
      'OPENAI_API_KEY is not set',
      'BENCH_MAX_USD (total spending cap) is not set',
      `BENCH_CONFIRM_SPEND must equal the dry-run maximum "${plan.confirmValue}"`,
    ]);

    const tooLow = { ...env, BENCH_LIVE: '1', OPENAI_API_KEY: 'x', BENCH_MAX_USD: '0.01' };
    const low = parseOptions(tooLow, corpus).options;
    expect(paidRunBlockers(plan, low, tooLow).join('\n')).toMatch(/exceeds BENCH_MAX_USD/);

    const ok = {
      ...env,
      BENCH_LIVE: '1',
      OPENAI_API_KEY: 'x',
      BENCH_MAX_USD: '5',
      BENCH_CONFIRM_SPEND: plan.confirmValue!,
    };
    expect(paidRunBlockers(plan, parseOptions(ok, corpus).options, ok)).toEqual([]);
    const wrong = { ...ok, BENCH_CONFIRM_SPEND: '9.99' };
    expect(paidRunBlockers(plan, parseOptions(wrong, corpus).options, wrong)).toHaveLength(1);
  });

  it('refuses a model without pricing (the maximum cannot be bounded)', () => {
    const env = { BENCH_CASES: 'authz-bypass', BENCH_MODEL_ID: 'unknown-model' };
    const { options } = parseOptions(env, corpus);
    const plan = buildPlan(options, corpus, new Map());
    expect(plan.maxUsd).toBeNull();
    expect(paidRunBlockers(plan, options, env).join('\n')).toMatch(/no pricing/);
  });

  it('rounds the confirmation value up to the cent', () => {
    expect(usdCeil(0.0412)).toBe('0.05');
    expect(usdCeil(1)).toBe('1.00');
  });

  it.runIf(process.env.BENCH_DRY_RUN === '1')(
    'dry run: prints the plan and writes out/live-dry-run.md',
    async () => {
      const { options, errors } = parseOptions(process.env, corpus);
      expect(errors).toEqual([]);
      const usage = await scriptedUsage(options.cases);
      const plan = buildPlan(options, corpus, usage);
      const report = renderDryRun(plan, options, paidRunBlockers(plan, options, process.env));
      // The scripted baseline of the same selection, for comparison with a later capture.
      // Sequential: runCase installs its responder on the shared generateText mock.
      const pass = [];
      for (const id of options.cases) {
        const r = await runCase(
          corpus.find((x) => x.id === id)!,
          'baseline',
          generateTextMock,
        );
        if (r) pass.push(r);
      }
      const passes = [pass];
      const set: RunSet = {
        label: 'scripted baseline',
        provenance: 'scripted',
        passes,
        reviewLatencyMs: [],
      };
      const full = [report, renderRunSetReport(set, computeRunSetMetrics(set))].join('\n');
      mkdirSync(join(BENCH_DIR, 'out'), { recursive: true });
      writeFileSync(join(BENCH_DIR, 'out', 'live-dry-run.md'), full);
      console.info(full);
    },
  );
});
