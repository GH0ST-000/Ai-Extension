/**
 * Phase 1 review-quality benchmark (replay). Runs with the unit suite; no network, no cost.
 *
 *   BENCH_UPDATE=1  re-pin manifest.json and expected-results.json after an intended change
 *   BENCH_REPORT=1  write Markdown reports to test/benchmark/out/
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { BENCH_DIR, caseSources, loadCorpus, runCase, type CaseRun } from './harness';
import { currentPins, type Pins } from './live/capture';
import { computeMetrics, renderReport } from './metrics';

const generateTextMock = vi.fn();
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return { ...actual, generateText: (...args: unknown[]) => generateTextMock(...args) };
});

const UPDATE = process.env.BENCH_UPDATE === '1';
const REPORT = process.env.BENCH_REPORT === '1';
const MANIFEST = join(BENCH_DIR, 'manifest.json');
const EXPECTED = join(BENCH_DIR, 'expected-results.json');
const RUNS = ['baseline', 'adversarial-refutation', 'adversarial-confirmation'] as const;

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

type Manifest = Pins & {
  corpusVersion: string;
  /** Security bugs that guard-aware refutation currently dismisses under a wrong refutation. */
  knownGaps: string[];
};

/** Snapshot form of a run (wall-clock removed). */
const snapshot = (runs: CaseRun[]) => ({
  cases: Object.fromEntries(
    runs.map(({ replayMs: _ms, caseId, runId: _r, ...rest }) => [caseId, rest]),
  ),
  metrics: computeMetrics(runs),
});

const results = new Map<string, CaseRun[]>();
async function replay(runId: string): Promise<CaseRun[]> {
  const cached = results.get(runId);
  if (cached) return cached;
  const runs: CaseRun[] = [];
  for (const c of loadCorpus()) {
    const r = await runCase(c, runId, generateTextMock);
    if (r) runs.push(r);
  }
  results.set(runId, runs);
  return runs;
}

describe('review quality benchmark — Phase 1 (replay)', () => {
  it('corpus, prompts, schemas, limits and model settings match the pinned manifest', async () => {
    const pins = await currentPins();
    if (UPDATE) {
      const previous = (() => {
        try {
          return readJson<Manifest>(MANIFEST);
        } catch {
          return null;
        }
      })();
      writeFileSync(
        MANIFEST,
        `${JSON.stringify(
          { corpusVersion: 'phase1-v1', knownGaps: previous?.knownGaps ?? [], ...pins },
          null,
          2,
        )}\n`,
      );
    }
    const manifest = readJson<Manifest>(MANIFEST);
    const { corpusVersion: _v, knownGaps: _g, ...pinned } = manifest;
    // A mismatch means sources, ground truth, prompts or settings changed: re-capture the
    // affected responses (or re-run with BENCH_UPDATE=1 for an intended change) and review.
    expect(pins).toEqual(pinned);
  });

  it('every case has ground truth that is independently inspectable', () => {
    for (const c of loadCorpus()) {
      if (c.clean) {
        expect(c.groundTruth).toEqual([]);
      } else {
        expect(c.groundTruth.length).toBeGreaterThan(0);
        for (const t of c.groundTruth) expect(t.witness).toMatch(/^witness\.spec\.ts › /);
      }
      expect(c.groundTruthSource).toMatch(/witness|line-referenced/);
    }
  });

  it('every stored patch equals git diff base → head (when git is available)', () => {
    try {
      execFileSync('git', ['--version']);
    } catch {
      return;
    }
    for (const c of loadCorpus().filter((x) => !x.fixtures)) {
      const sources = caseSources(c);
      for (const f of c.files.filter((x) => x.changed)) {
        const tmp = mkdtempSync(join(tmpdir(), 'bench-'));
        try {
          const name = f.physical ?? f.path.split('/').pop()!;
          const base = join(BENCH_DIR, 'corpus', c.id, 'base', name);
          let baseText: string | null = null;
          try {
            baseText = readFileSync(base, 'utf8');
          } catch {
            baseText = null;
          }
          writeFileSync(join(tmp, 'b'), sources.head(f.path) ?? '');
          if (baseText != null) writeFileSync(join(tmp, 'a'), baseText);
          let out = '';
          try {
            execFileSync(
              'git',
              [
                'diff',
                '--no-index',
                '--unified=3',
                '--no-color',
                baseText != null ? 'a' : '/dev/null',
                'b',
              ],
              { cwd: tmp, encoding: 'utf8' },
            );
          } catch (error) {
            out = String((error as { stdout?: string }).stdout ?? '');
          }
          const hunks = out.slice(out.indexOf('\n@@') + 1);
          expect(sources.changed.find((x) => x.path === f.path)?.hunks, `${c.id} ${f.path}`).toBe(
            hunks,
          );
        } finally {
          rmSync(tmp, { recursive: true, force: true });
        }
      }
    }
  }, 60_000); // one git diff per changed file of every case: slow under a parallel suite

  for (const runId of RUNS) {
    it(`replay "${runId}": per-stage results are deterministic and match the pinned expectations`, async () => {
      const runs = await replay(runId);
      const snap = snapshot(runs);
      if (UPDATE) {
        let all: Record<string, unknown> = {};
        try {
          all = readJson<Record<string, unknown>>(EXPECTED);
        } catch {
          all = {};
        }
        all[runId] = snap;
        writeFileSync(EXPECTED, `${JSON.stringify(all, null, 2)}\n`);
      }
      if (REPORT) {
        mkdirSync(join(BENCH_DIR, 'out'), { recursive: true });
        writeFileSync(
          join(BENCH_DIR, 'out', `report-${runId}.md`),
          renderReport(
            runId,
            runs,
            snap.metrics,
            runs.reduce((n, r) => n + r.replayMs, 0),
          ),
        );
      }
      expect(JSON.parse(JSON.stringify(snap))).toEqual(
        readJson<Record<string, unknown>>(EXPECTED)[runId],
      );
      // Replay never charges more than one usage unit per review.
      for (const r of runs) expect(r.usageUnits).toBeLessThanOrEqual(1);
    });
  }

  it('security regression: a wrong refutation never dismisses a real authorization bug, except documented known gaps', async () => {
    const runs = await replay('adversarial-refutation');
    const corpus = new Map(loadCorpus().map((c) => [c.id, c]));
    const dismissed = runs
      .filter((r) => corpus.get(r.caseId)?.securityRegression)
      .flatMap((r) => r.truth)
      .filter((t) => t.outcome === 'dismissed')
      .map((t) => t.id)
      .sort();
    const manifest = readJson<Manifest>(MANIFEST);
    if (UPDATE) {
      writeFileSync(
        MANIFEST,
        `${JSON.stringify({ ...manifest, knownGaps: dismissed }, null, 2)}\n`,
      );
    }
    // Each known gap is a real bug the deterministic gates cannot defend against a wrong,
    // grounded refutation. The list must shrink, never grow silently.
    expect(dismissed).toEqual(readJson<Manifest>(MANIFEST).knownGaps);
  });

  it('adversarial confirmation: fabricated paths or stitched quotes never get a clean-case finding confirmed', async () => {
    const runs = await replay('adversarial-confirmation');
    expect(runs.length).toBeGreaterThan(0);
    const confirmed = runs
      .filter((r) => r.clean)
      .flatMap((r) =>
        r.candidates.filter((c) => c.final === 'confirmed').map((c) => `${r.caseId}: ${c.title}`),
      );
    expect(confirmed).toEqual([]);
  });
});
