/**
 * Captured-response replay. Runs with the unit suite; never contacts a model.
 *
 * 1. Always: synthetic captures are recorded through the real recording path (a fake provider
 *    answers with the scripted responses) and replayed; replay must reproduce the scripted
 *    results exactly and must reject drifted captures.
 * 2. When real captures exist under test/benchmark/captures/ (git-ignored), each one is
 *    replayed through the current pipeline and reported as "captured";
 *    BENCH_REPORT=1 writes test/benchmark/out/captured-<captureId>.md.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { PR_REVIEW_BATCH_INSTRUCTIONS } from '../../../src/ai/pr-review/pr-review-batch.prompt';
import { PR_REVIEW_VERIFY_INSTRUCTIONS } from '../../../src/ai/pr-review/pr-review-verify';
import {
  BENCH_DIR,
  describeCall,
  loadCorpus,
  runCase,
  scriptedResponder,
  type BenchCase,
  type CaseRun,
} from '../harness';
import { computeMetrics, computeRunSetMetrics, renderReport, renderRunSetReport } from '../metrics';
import {
  assertNoSecrets,
  CAPTURE_SCHEMA_VERSION,
  capturePins,
  currentPins,
  loadCaptures,
  scrub,
  type CaptureSession,
  type CaseCapture,
  type GenerateResult,
} from './capture';
import { captureCase, replayCapture, saveCapture, stageGeneration } from './runner';

const generateTextMock = vi.fn();
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateText: (...args: unknown[]) => generateTextMock(...args) };
});

const MODEL = { provider: 'openai', id: 'gpt-4o-mini' };
const FACTORY = {
  getDefaultModel: () => 'fake-provider',
  getProviderName: () => MODEL.provider,
  getModelName: () => MODEL.id,
};
const FAKE_KEY = 'sk-benchFAKEkey0000000000000000';

const corpus = loadCorpus();
const byId = new Map(corpus.map((c) => [c.id, c]));
const tmpRoot = mkdtempSync(join(tmpdir(), 'bench-captures-'));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

/** A fake provider answering like the scripted run, with provider-shaped results. */
function fakeProvider(c: BenchCase, runId: string) {
  const scripted = scriptedResponder(c.responses.runs.find((r) => r.id === runId)!);
  return async (args: unknown): Promise<GenerateResult> => {
    const reply = await scripted(describeCall(args));
    const input = reply.usage.inputTokens ?? 0;
    const output = reply.usage.outputTokens ?? 0;
    return {
      output: reply.output,
      finishReason: reply.finishReason,
      usage: { inputTokens: input, outputTokens: output, totalTokens: input + output },
      response: { modelId: 'gpt-4o-mini-2024-07-18' },
    };
  };
}

/**
 * Record a synthetic capture session: plan[i] = scripted run used for run index i (a case
 * without that scripted run uses its baseline).
 */
async function synthesize(captureId: string, caseIds: string[], plan: string[]) {
  const pins = await currentPins(corpus);
  const cases: CaseCapture[] = [];
  const live: CaseRun[] = [];
  for (const [runIndex, runId] of plan.entries()) {
    for (const id of caseIds) {
      const c = byId.get(id)!;
      const scriptedRun = c.responses.runs.some((r) => r.id === runId) ? runId : 'baseline';
      const { run, capture } = await captureCase({
        c,
        runIndex,
        captureId,
        generateTextMock,
        generate: fakeProvider(c, scriptedRun),
        modelFactory: FACTORY,
        model: MODEL,
        secrets: [FAKE_KEY],
      });
      cases.push(capture);
      if (run) live.push(run);
    }
  }
  const session: CaptureSession = {
    schemaVersion: CAPTURE_SCHEMA_VERSION,
    captureId,
    provenance: 'captured',
    createdAt: '2026-01-01T00:00:00.000Z',
    model: MODEL,
    generation: stageGeneration(cases),
    pins: capturePins(pins, caseIds),
    selection: { cases: caseIds, group: null, runs: plan.length },
    budget: { maxUsd: 1, plannedMaxUsd: 1, spentEstimatedUsd: 0 },
    completed: cases.map((x) => `${x.caseId}.run${x.runIndex}.json`),
    skipped: [],
  };
  const dir = join(tmpRoot, captureId);
  saveCapture(dir, session, cases, [FAKE_KEY]);
  return { dir, session, cases, live };
}

/** Comparable form of a case run (drops provenance, timing and run label). */
const comparable = (r: CaseRun) => {
  const { provenance: _p, replayMs: _ms, modelLatencyMs: _l, runId: _r, ...rest } = r;
  return JSON.parse(JSON.stringify(rest)) as unknown;
};

async function scripted(caseId: string, runId: string) {
  return (await runCase(byId.get(caseId)!, runId, generateTextMock))!;
}

const loadOne = (dir: string) => loadCaptures(join(dir, '..')).find((l) => l.dir === dir)!;

describe('captured replay (synthetic captures, no model)', () => {
  const CASES = [
    'authz-bypass',
    'request-body-userid',
    'request-principal-userid',
    'clean-defensive',
  ];

  it('records real-call shape without secrets: hashes, usage, latency, cost, model id', async () => {
    const { cases, session } = await synthesize(
      'synthetic-shape',
      ['request-body-userid'],
      ['baseline'],
    );
    const calls = cases[0]!.calls;
    expect(calls.map((x) => x.stage)).toEqual(['batch', 'verify']);
    for (const x of calls) {
      expect(x.promptHash).toMatch(/^[0-9a-f]{64}$/);
      expect(x.generationHash).toMatch(/^[0-9a-f]{64}$/);
      expect(x.usage.inputTokens).toBeGreaterThan(0);
      expect(x.latencyMs).toBeGreaterThanOrEqual(0);
      expect(x.responseModelId).toBe('gpt-4o-mini-2024-07-18');
      expect(x.costUsd.estimated).toBeGreaterThan(0);
      expect(x.costUsd.provider).toBeNull();
      expect(x.generation).toMatchObject({ maxRetries: 0 });
    }
    expect(calls[1]!.identity.title).toBeTruthy();
    expect(session.generation.batch).toMatchObject({ temperature: null, maxOutputTokens: 4096 });
    expect(session.generation.verify).toMatchObject({ temperature: null, maxOutputTokens: 800 });
    // No prompt text, model object or credentials are stored.
    const text = readFileSync(
      join(tmpRoot, 'synthetic-shape', 'request-body-userid.run0.json'),
      'utf8',
    );
    expect(text).not.toContain(PR_REVIEW_BATCH_INSTRUCTIONS.slice(0, 80));
    expect(text).not.toContain(PR_REVIEW_VERIFY_INSTRUCTIONS.slice(0, 80));
    expect(text).not.toContain('reviewFiles:');
    expect(text).not.toContain('@@ ');
    expect(text).not.toContain(FAKE_KEY);
  });

  it('replays identically to the scripted run and reports provenance "captured"', async () => {
    const { dir } = await synthesize('synthetic-roundtrip', CASES, ['baseline', 'baseline']);
    const out = await replayCapture(
      loadOne(dir),
      corpus,
      await currentPins(corpus),
      generateTextMock,
    );
    expect(out.rejected).toEqual([]);
    expect(out.rejectedRuns).toEqual([]);
    expect(out.set!.provenance).toBe('captured');
    expect(out.set!.passes).toHaveLength(2);
    for (const pass of out.set!.passes) {
      for (const r of pass) {
        expect(r.provenance).toBe('captured');
        expect(r.modelLatencyMs).not.toBeNull();
        expect(comparable(r)).toEqual(comparable(await scripted(r.caseId, 'baseline')));
      }
    }
    const m = computeRunSetMetrics(out.set!);
    expect(m.provenance).toBe('captured');
    expect(m.latencyMs.p50).not.toBeNull();
    expect(m.variance.unstableBugs).toEqual([]);
    expect(renderRunSetReport(out.set!, m)).toContain('**Provenance: captured.**');
  });

  it('security regression survives a wrong refutation in captured replay; run-to-run variance is measured', async () => {
    // Run 0: correct verifier. Run 1: the verifier wrongly refutes by quoting the membership query.
    const { dir } = await synthesize(
      'synthetic-security',
      ['request-body-userid', 'request-principal-userid'],
      ['baseline', 'adversarial-refutation'],
    );
    const out = await replayCapture(
      loadOne(dir),
      corpus,
      await currentPins(corpus),
      generateTextMock,
    );
    const runs = out.set!.passes.flat();
    const bug = runs
      .filter((r) => r.caseId === 'request-body-userid')
      .map((r) => r.truth[0]!.outcome);
    expect(bug).toEqual(['confirmed', 'needs_investigation']);
    expect(
      runs.find(
        (r) => r.caseId === 'request-body-userid' && r.truth[0]!.outcome === 'needs_investigation',
      )!.candidates[0]!.verification,
    ).toMatchObject({ verifierVerdict: 'refuted' });
    const safe = runs.find((r) => r.caseId === 'request-principal-userid')!;
    expect(safe.candidates.map((c) => c.final)).toEqual(['dismissed']);
    const m = computeRunSetMetrics(out.set!);
    expect(m.securityFalseDismissalRate).toBe(0);
    expect(m.unresolvedTruePositiveRate).toBe(0.5);
    expect(m.variance.unstableBugs).toEqual(['request-body-userid/client-chosen-identity']);
    expect(m.falsePositives).toBe(0);
  });

  it('rejects a capture whose pins (prompts, schemas, limits, case sources) differ', async () => {
    const { dir } = await synthesize('synthetic-pins', ['authz-bypass'], ['baseline']);
    const loaded = loadOne(dir);
    const pins = await currentPins(corpus);
    const drifted = {
      ...loaded,
      session: {
        ...loaded.session,
        pins: {
          ...loaded.session.pins,
          prompts: { ...loaded.session.pins.prompts, verifySchema: 'stale' },
          review: {
            ...loaded.session.pins.review,
            limits: { ...loaded.session.pins.review.limits, maxVerifications: 99 },
          },
        },
      },
    };
    const out = await replayCapture(drifted, corpus, pins, generateTextMock);
    expect(out.set).toBeNull();
    expect(out.rejected).toEqual([
      'pin changed: prompts.verifySchema',
      'pin changed: review.limits.maxVerifications',
    ]);
    const source = {
      ...loaded,
      session: {
        ...loaded.session,
        pins: {
          ...loaded.session.pins,
          corpus: {
            'authz-bypass': { ...loaded.session.pins.corpus['authz-bypass']!, sources: 'x' },
          },
        },
      },
    };
    expect((await replayCapture(source, corpus, pins, generateTextMock)).rejected).toEqual([
      'pin changed: corpus.authz-bypass.sources',
    ]);
    // Relabelled ground truth re-scores the answers; it does not invalidate them.
    const relabelled = {
      ...loaded,
      session: {
        ...loaded.session,
        pins: {
          ...loaded.session.pins,
          corpus: {
            'authz-bypass': {
              ...loaded.session.pins.corpus['authz-bypass']!,
              groundTruth: ['authz-bypass/old-label'],
            },
          },
        },
      },
    };
    const relabelledOut = await replayCapture(relabelled, corpus, pins, generateTextMock);
    expect(relabelledOut.rejected).toEqual([]);
    expect(relabelledOut.notices).toEqual([
      'authz-bypass: ground-truth ids changed since capture; scored with current labels',
    ]);
    // A v1 session (whole-folder pin, no `sources`) whose folder changed is replayed with a
    // notice: its model inputs are still checked per request by prompt hash.
    const { sources: _s, ...v1Pin } = loaded.session.pins.corpus['authz-bypass']!;
    const v1 = {
      ...loaded,
      session: {
        ...loaded.session,
        schemaVersion: 1,
        pins: {
          ...loaded.session.pins,
          corpus: { 'authz-bypass': { ...v1Pin, files: 'stale' } },
        },
      },
    };
    const v1Out = await replayCapture(v1, corpus, pins, generateTextMock);
    expect(v1Out.rejected).toEqual([]);
    expect(v1Out.notices[0]).toMatch(/v1 capture pinned the whole case folder/);
    expect(v1Out.rejectedRuns).toEqual([]);
  });

  it('rejects a case-run whose prompt or generation parameters no longer match', async () => {
    const { dir } = await synthesize('synthetic-hash', ['request-body-userid'], ['baseline']);
    const loaded = loadOne(dir);
    const pins = await currentPins(corpus);
    const tamper = (f: (c: CaseCapture['calls'][number]) => CaseCapture['calls'][number]) => ({
      ...loaded,
      cases: loaded.cases.map((c) => ({ ...c, calls: c.calls.map(f) })),
    });
    const prompt = await replayCapture(
      tamper((x) => (x.stage === 'verify' ? { ...x, promptHash: '0'.repeat(64) } : x)),
      corpus,
      pins,
      generateTextMock,
    );
    expect(prompt.rejectedRuns).toHaveLength(1);
    expect(prompt.rejectedRuns[0]!.reasons.join('\n')).toMatch(/verify .*prompt hash not captured/);
    expect(prompt.rejectedRuns[0]!.reasons.join('\n')).toMatch(/was never requested/);
    expect(prompt.set!.passes).toEqual([]);

    const generation = await replayCapture(
      tamper((x) => (x.stage === 'batch' ? { ...x, generationHash: '1'.repeat(64) } : x)),
      corpus,
      pins,
      generateTextMock,
    );
    expect(generation.rejectedRuns[0]!.reasons.join('\n')).toMatch(
      /batch .*generation parameters differ/,
    );
  });

  it('never writes secrets: known values and secret-shaped strings are refused or scrubbed', () => {
    expect(() => assertNoSecrets(JSON.stringify({ note: FAKE_KEY }), [])).toThrow(/openai-key/);
    expect(() => assertNoSecrets('{"x":"abcdefgh12345678"}', ['abcdefgh12345678'])).toThrow(
      /secret value/,
    );
    expect(() => assertNoSecrets('{"authorization": "x"}', [])).toThrow(/auth-header/);
    expect(() => assertNoSecrets('{"ok":"ghp_short"}', [])).not.toThrow();
    expect(scrub(`401: bad key ${FAKE_KEY}`, [])).toBe('401: bad key [redacted]');
  });

  it('a provider error is captured (scrubbed) and replayed as the same failed review', async () => {
    const c = byId.get('authz-bypass')!;
    const { capture, run, failure } = await captureCase({
      c,
      runIndex: 0,
      captureId: 'synthetic-error',
      generateTextMock,
      generate: async () => {
        throw Object.assign(new Error(`Incorrect API key provided: ${FAKE_KEY}`), {
          name: 'AI_APICallError',
        });
      },
      modelFactory: FACTORY,
      model: MODEL,
      secrets: [FAKE_KEY],
    });
    expect(run).toBeNull();
    expect(failure).toMatch(/ServiceUnavailableException/);
    expect(capture.calls.length).toBeGreaterThan(0);
    expect(capture.calls[0]!.error).toEqual({
      name: 'AI_APICallError',
      message: 'Incorrect API key provided: [redacted]',
    });
    expect(JSON.stringify(capture)).not.toContain(FAKE_KEY);
    const dir = join(tmpRoot, 'synthetic-error');
    saveCapture(
      dir,
      {
        schemaVersion: CAPTURE_SCHEMA_VERSION,
        captureId: 'synthetic-error',
        provenance: 'captured',
        createdAt: '2026-01-01T00:00:00.000Z',
        model: MODEL,
        generation: stageGeneration([capture]),
        pins: capturePins(await currentPins(corpus), [c.id]),
        selection: { cases: [c.id], group: null, runs: 1 },
        budget: { maxUsd: 1, plannedMaxUsd: 1, spentEstimatedUsd: 0 },
        completed: ['authz-bypass.run0.json'],
        skipped: [],
      },
      [capture],
      [FAKE_KEY],
    );
    const out = await replayCapture(
      loadOne(dir),
      corpus,
      await currentPins(corpus),
      generateTextMock,
    );
    expect(out.rejectedRuns).toEqual([]);
    expect(out.failedRuns).toEqual([
      { caseId: 'authz-bypass', runIndex: 0, failure: capture.reviewFailure },
    ]);
    expect(out.set!.passes).toEqual([]);
  });
});

describe('captured replay (real captures, if any)', () => {
  const sessions = loadCaptures();
  it.skipIf(sessions.length === 0)(
    'replays every capture under test/benchmark/captures through the current pipeline',
    async () => {
      const pins = await currentPins(corpus);
      for (const loaded of sessions) {
        const out = await replayCapture(loaded, corpus, pins, generateTextMock);
        const lines = [
          `capture ${out.captureId}: ${out.rejected.length ? `REJECTED (${out.rejected.join('; ')})` : 'valid'}`,
          ...out.notices.map((n) => `  notice: ${n}`),
          ...out.rejectedRuns.map(
            (r) => `  rejected ${r.caseId} run ${r.runIndex}: ${r.reasons.join('; ')}`,
          ),
          ...out.failedRuns.map(
            (r) => `  review failed ${r.caseId} run ${r.runIndex}: ${r.failure}`,
          ),
        ];
        console.info(lines.join('\n'));
        if (!out.set && process.env.BENCH_REPORT === '1') {
          // Never leave an earlier report standing for a capture that no longer replays.
          mkdirSync(join(BENCH_DIR, 'out'), { recursive: true });
          writeFileSync(
            join(BENCH_DIR, 'out', `captured-${out.captureId}.md`),
            [
              `# Capture ${out.captureId} — REJECTED by strict replay`,
              '',
              'The current engine does not send the requests this capture recorded (its pins',
              'differ), so its answers cannot be replayed. Results require a fresh live capture.',
              '',
              ...lines,
              '',
            ].join('\n'),
          );
        }
        if (out.set && process.env.BENCH_REPORT === '1') {
          mkdirSync(join(BENCH_DIR, 'out'), { recursive: true });
          writeFileSync(
            join(BENCH_DIR, 'out', `captured-${out.captureId}.md`),
            [
              renderRunSetReport(out.set, computeRunSetMetrics(out.set)),
              ...lines,
              '',
              // Per-stage trace of every candidate, run by run.
              ...out.set.passes.map((pass, i) =>
                renderReport(`${out.captureId} run ${i}`, pass, computeMetrics(pass), 0)
                  .replace(/^# /, '## ')
                  .replace(/^## (Metrics|Funnel|Ground truth|Candidates)/gm, '### $1'),
              ),
              '',
            ].join('\n'),
          );
        }
        // A valid capture must replay completely: stale case-runs are reported above.
        if (out.set) expect(out.set.provenance).toBe('captured');
      }
    },
  );
});
