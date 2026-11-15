/**
 * LIVE capture (PAID). Skipped unless BENCH_LIVE=1, and refuses to start unless every
 * precondition of `paidRunBlockers` holds:
 *
 *   BENCH_LIVE=1                opt-in
 *   OPENAI_API_KEY              read from the environment only; never written anywhere
 *   BENCH_MAX_USD=<cap>         total spending cap; the planned maximum must fit under it
 *   BENCH_CONFIRM_SPEND=<max>   must equal the "Maximum total" printed by the dry run
 *   BENCH_CASES / BENCH_GROUP / BENCH_RUNS / BENCH_MODEL_ID   selection (see plan.ts)
 *
 * Each review runs through the production pipeline with the production model factory and
 * limits; only `generateText` is wrapped to record the answer. Before each review the
 * remaining cap must cover a worst-case review, so the cap cannot be exceeded. Captures go
 * to test/benchmark/captures/<captureId>/ (git-ignored); replay them with captured.spec.ts.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { AiModelFactory } from '../../../src/ai/models/ai-model.factory';
import { BENCH_DIR, loadCorpus, runCase, type CaseRun } from '../harness';
import { computeRunSetMetrics, renderRunSetReport, type RunSet } from '../metrics';
import {
  CAPTURE_SCHEMA_VERSION,
  CAPTURES_DIR,
  capturePins,
  currentPins,
  secretValues,
  type CaptureSession,
  type CaseCapture,
  type GenerateResult,
} from './capture';
import { buildPlan, paidRunBlockers, parseOptions, renderDryRun, type TokenBound } from './plan';
import { captureCase, saveCapture, stageGeneration } from './runner';

const generateTextMock = vi.fn();
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateText: (...args: unknown[]) => generateTextMock(...args) };
});

const LIVE = process.env.BENCH_LIVE === '1';

describe.skipIf(!LIVE)('LIVE capture (paid, opt-in)', () => {
  it(
    'captures real batch and verification answers within the spending cap',
    async () => {
      const env = process.env;
      const corpus = loadCorpus();
      // Pinned before any paid call: the capture records exactly the code it ran against.
      const pinsNow = await currentPins(corpus);
      const { options, errors } = parseOptions(env, corpus);
      if (errors.length > 0) throw new Error(`invalid selection: ${errors.join('; ')}`);

      const usage = new Map<string, TokenBound>();
      for (const id of options.cases) {
        const r = await runCase(
          corpus.find((c) => c.id === id)!,
          'baseline',
          generateTextMock,
        );
        if (r)
          usage.set(id, { input: r.tokens.input, output: r.tokens.output, calls: r.tokens.calls });
      }
      const plan = buildPlan(options, corpus, usage);
      const blockers = paidRunBlockers(plan, options, env);
      if (blockers.length > 0) {
        throw new Error(`paid run refused:\n${renderDryRun(plan, options, blockers)}`);
      }
      const cap = options.maxUsd!;
      const perReviewWorst = plan.perReviewWorst.usd!;

      const { generateText } = await vi.importActual<typeof import('ai')>('ai');
      const generate = (args: unknown) =>
        generateText(
          args as Parameters<typeof generateText>[0],
        ) as unknown as Promise<GenerateResult>;
      const modelFactory = new AiModelFactory({
        get: () => ({
          provider: 'openai',
          model: options.model.id,
          openaiApiKey: env.OPENAI_API_KEY,
        }),
      } as never);
      const secrets = secretValues(env);

      const captureId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${options.model.id}-${randomBytes(3).toString('hex')}`;
      const dir = join(CAPTURES_DIR, captureId);
      const cases: CaseCapture[] = [];
      const skipped: CaptureSession['skipped'] = [];
      const passes: CaseRun[][] = [];
      const latencies: number[] = [];
      let spent = 0;

      for (let runIndex = 0; runIndex < options.runs; runIndex += 1) {
        for (const id of options.cases) {
          if (spent + perReviewWorst > cap) {
            skipped.push({
              caseId: id,
              runIndex,
              reason: 'spending cap: remaining budget below a worst-case review',
            });
            continue;
          }
          const { run, capture, failure } = await captureCase({
            c: corpus.find((c) => c.id === id)!,
            runIndex,
            captureId,
            generateTextMock,
            generate,
            modelFactory,
            model: options.model,
            secrets,
          });
          // Charge actual usage; a call without reported usage counts as its worst case.
          spent += capture.calls.reduce(
            (n, x) =>
              n + (x.costUsd.estimated ?? perReviewWorst / Math.max(1, plan.perReviewWorst.calls)),
            0,
          );
          cases.push(capture);
          saveCapture(dir, sessionOf(), cases, secrets);
          if (failure) skipped.push({ caseId: id, runIndex, reason: `review failed: ${failure}` });
          if (run) {
            (passes[runIndex] ??= []).push(run);
            latencies.push(capture.reviewLatencyMs);
          }
          console.info(
            `[live] ${id} run ${runIndex}: ${failure ? 'failed' : 'ok'}; spent ≈ $${spent.toFixed(4)} of $${cap}`,
          );
        }
      }

      function sessionOf(): CaptureSession {
        return {
          schemaVersion: CAPTURE_SCHEMA_VERSION,
          captureId,
          provenance: 'captured',
          createdAt: new Date().toISOString(),
          model: options.model,
          generation: stageGeneration(cases),
          pins: capturePins(pinsNow, options.cases),
          selection: { cases: options.cases, group: options.group, runs: options.runs },
          budget: { maxUsd: cap, plannedMaxUsd: plan.maxUsd!, spentEstimatedUsd: spent },
          completed: cases.map((c) => `${c.caseId}.run${c.runIndex}.json`),
          skipped,
        };
      }
      saveCapture(dir, sessionOf(), cases, secrets);

      const set: RunSet = {
        label: `live capture ${captureId}`,
        provenance: 'live',
        passes: passes.filter(Boolean),
        reviewLatencyMs: latencies,
      };
      const report = renderRunSetReport(set, computeRunSetMetrics(set));
      mkdirSync(join(BENCH_DIR, 'out'), { recursive: true });
      writeFileSync(join(BENCH_DIR, 'out', `live-${captureId}.md`), report);
      console.info(report);
      expect(spent).toBeLessThanOrEqual(cap);
    },
    60 * 60 * 1000,
  );
});
