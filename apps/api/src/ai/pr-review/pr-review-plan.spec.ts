import { describe, expect, it } from 'vitest';

import { buildCoverage, scopeFromPlan } from './pr-review-coverage';
import { chunkPatch, locateEvidence, parsePatch, rangeTouchesLines } from './diff-hunks';
import { makeFile, makePatch, sixtyOneFilePr } from './pr-review-fixtures';
import { categorizeFile, filePriority } from './pr-review-files';
import {
  CHARS_PER_TOKEN,
  DEFAULT_PR_REVIEW_LIMITS,
  effectiveMaxBatches,
  planPrReview,
  sanitizeLimits,
  unitChars,
  type PrReviewLimits,
} from './pr-review-plan';

const OVERHEAD = 6_000;
const limits = (over: Partial<PrReviewLimits> = {}): PrReviewLimits => ({
  ...DEFAULT_PR_REVIEW_LIMITS,
  ...over,
});
const allSucceeded = (plan: ReturnType<typeof planPrReview>) =>
  plan.batches.map((b) => ({ id: b.id, status: 'succeeded' as const, attempts: 1, files: 0 }));
const noFindings = {
  accepted: 0,
  duplicates: 0,
  rejected: 0,
  rejectedByReason: {},
  linesCorrected: 0,
};

describe('diff hunks', () => {
  const patch = ['@@ -10,3 +10,4 @@ fn', ' keep', '-old()', '+new()', '+extra()', ' tail'].join(
    '\n',
  );

  it('maps new/old line numbers per hunk', () => {
    const [hunk] = parsePatch(patch);
    expect(hunk!.lines.map((l) => [l.kind, l.oldLine, l.newLine])).toEqual([
      [' ', 10, 10],
      ['-', 11, null],
      ['+', null, 11],
      ['+', null, 12],
      [' ', 12, 13],
    ]);
  });

  it('locates evidence (with or without diff markers) and rejects text not in the diff', () => {
    const lines = parsePatch(patch)[0]!.lines;
    expect(locateEvidence(lines, '+new()\n+extra()')).toEqual({ start: 11, end: 12 });
    expect(locateEvidence(lines, 'new()')).toEqual({ start: 11, end: 11 });
    expect(locateEvidence(lines, 'deleteEverything()')).toBeNull();
    expect(rangeTouchesLines(lines, 11, 11)).toBe(true);
    expect(rangeTouchesLines(lines, 11, 11) && rangeTouchesLines(lines, 500, 510)).toBe(false);
  });

  it('splits an oversized hunk at line boundaries without losing any line', () => {
    const big = makePatch(400, { width: 60 });
    const chunks = chunkPatch(big, 5_000);
    expect(chunks.length).toBeGreaterThan(4);
    expect(chunks.every((c) => c.text.length <= 5_000)).toBe(true);
    expect(chunks.flatMap((c) => c.lines.map((l) => l.newLine))).toEqual(
      Array.from({ length: 400 }, (_, i) => i + 1),
    );
    // Continuation headers carry real line numbers.
    expect(chunks[1]!.text).toMatch(/^@@ -\? \+\d+ @@ \(hunk continued\)/);
    expect(chunks.some((c) => c.lineCut)).toBe(false);
  });

  it('flags (never hides) a single line longer than the chunk budget', () => {
    const minified = `@@ -1,0 +1,1 @@\n+${'a'.repeat(9_000)}`;
    const [chunk] = chunkPatch(minified, 1_000);
    expect(chunk!.lineCut).toBe(true);
    expect(chunk!.text.length).toBeLessThanOrEqual(1_000);
  });
});

describe('file classification and priority', () => {
  it.each([
    ['pnpm-lock.yaml', '+a', 'excluded_generated'],
    ['dist/app.js', '+a', 'excluded_generated'],
    ['assets/logo.png', null, 'excluded_binary'],
    ['src/huge.ts', null, 'no_patch'],
    ['src/a.ts', '+a', 'reviewable'],
  ])('%s → %s', (path, patch, expected) => {
    expect(categorizeFile(makeFile(path, patch as string | null))).toBe(expected);
  });

  it('treats a pure rename without changes as intentionally excluded', () => {
    expect(categorizeFile(makeFile('src/b.ts', null, { status: 'renamed', changes: 0 }))).toBe(
      'excluded_no_changes',
    );
  });

  it('ranks security-sensitive source above source, tests and docs', () => {
    const p = (path: string) => filePriority({ path, status: 'modified' });
    expect(p('apps/api/src/auth/session.ts')).toBeGreaterThan(p('apps/web/src/button.tsx'));
    expect(p('prisma/migrations/001/migration.sql')).toBeGreaterThan(p('apps/web/src/button.tsx'));
    expect(p('apps/web/src/button.tsx')).toBeGreaterThan(p('apps/web/src/button.spec.tsx'));
    expect(p('apps/web/src/button.spec.tsx')).toBeGreaterThan(p('docs/readme.md'));
    expect(p('apps/api/src/auth/session.spec.ts')).toBeLessThan(p('apps/api/src/auth/session.ts'));
  });
});

describe('planPrReview', () => {
  it('the 61-file QA PR: the old 60k alphabetical budget reached 25 files; the plan covers every reviewable file', () => {
    const files = sixtyOneFilePr();

    // Reproduce the old behaviour (60,000 chars in GitHub alphabetical order).
    const alphabetical = files
      .filter((f) => categorizeFile(f) === 'reviewable')
      .sort((a, b) => (a.path < b.path ? -1 : 1));
    let used = 0;
    let oldAnalyzed = 0;
    for (const f of alphabetical) {
      const remaining = 60_000 - used;
      if (remaining < 200) break;
      used += Math.min(f.patch!.length, 8_000, remaining);
      oldAnalyzed += 1;
    }
    expect(oldAnalyzed).toBe(25);

    const plan = planPrReview({
      files,
      totalFiles: 61,
      source: 'github_api',
      overheadChars: OVERHEAD,
      limits: limits(),
    });
    expect(plan.batches.length).toBeGreaterThan(1);
    expect(plan.batches.length).toBeLessThanOrEqual(effectiveMaxBatches(limits()));

    const coverage = buildCoverage({
      plan,
      outcomes: allSucceeded(plan),
      findings: noFindings,
      riskFor: () => 'low',
      usageUnits: 1,
    });
    expect(coverage.counts).toMatchObject({
      reviewed_full: 58,
      reviewed_partial: 0,
      excluded_generated: 1,
      excluded_binary: 1,
      no_patch: 1,
      deferred_budget: 0,
      not_fetched: 0,
    });
    // Every one of the 61 files has exactly one status.
    expect(coverage.files).toHaveLength(61);
    expect(new Set(coverage.files.map((f) => f.path)).size).toBe(61);
    // A source file without a patch means reviewable code was not covered.
    expect(coverage.complete).toBe(false);
  });

  it('orders by priority, not GitHub alphabetical order, when the budget is tight', () => {
    const files = sixtyOneFilePr();
    const plan = planPrReview({
      files,
      totalFiles: 61,
      source: 'github_api',
      overheadChars: OVERHEAD,
      limits: limits({ maxBatches: 1 }),
    });
    const planned = plan.files.filter((f) => f.plannedChunks.length > 0).map((f) => f.path);
    expect(planned.slice(0, 5).every((p) => p.startsWith('apps/api/src/auth/'))).toBe(true);
    expect(planned.some((p) => p.startsWith('docs/'))).toBe(false);
    const deferred = plan.files.filter(
      (f) => f.category === 'reviewable' && f.plannedChunks.length === 0,
    );
    expect(deferred.length).toBeGreaterThan(0);
    expect(deferred.every((f) => !f.path.includes('/auth/'))).toBe(true);
  });

  it('respects the exact batch budget boundary (fits at the limit, defers one char over)', () => {
    const budget = DEFAULT_PR_REVIEW_LIMITS.batchInputTokens * CHARS_PER_TOKEN - OVERHEAD;
    const unitFor = (patch: string) =>
      unitChars({ path: 'src/a.ts', chunk: { text: patch, lines: [], lineCut: false } });
    const pad = (target: number) => {
      // Build a single-hunk patch whose unit size is exactly `target`.
      const header = '@@ -1,0 +1,1 @@\n+';
      const filler = target - unitFor(`${header}`);
      return `${header}${'z'.repeat(filler)}`;
    };
    const exact = pad(budget);
    expect(unitFor(exact)).toBe(budget);
    const one = limits({ maxBatches: 1 });

    const fits = planPrReview({
      files: [makeFile('src/a.ts', exact)],
      totalFiles: 1,
      source: 'github_api',
      overheadChars: OVERHEAD,
      limits: one,
    });
    expect(fits.batches).toHaveLength(1);
    expect(fits.files[0]!.chunks).toHaveLength(1);
    expect(fits.batches[0]!.diffChars).toBe(budget);

    const second = planPrReview({
      files: [makeFile('src/a.ts', exact), makeFile('src/b.ts', makePatch(1))],
      totalFiles: 2,
      source: 'github_api',
      overheadChars: OVERHEAD,
      limits: one,
    });
    expect(second.files.find((f) => f.path === 'src/b.ts')!.plannedChunks).toEqual([]);
  });

  it('never exceeds the input, output or batch ceilings', () => {
    const files = Array.from({ length: 300 }, (_, i) =>
      makeFile(`src/f${i}.ts`, makePatch(80, { tag: `f${i}_` })),
    );
    const tight = limits({
      maxBatches: 12,
      maxInputTokens: 40_000,
      batchInputTokens: 10_000,
      maxTotalOutputTokens: 9_000,
      maxOutputTokensPerBatch: 3_000,
    });
    const plan = planPrReview({
      files,
      totalFiles: 300,
      source: 'github_api',
      overheadChars: OVERHEAD,
      limits: tight,
    });
    expect(plan.batches).toHaveLength(3); // min(12, 40k/10k=4, 9k/3k=3)
    expect(plan.estimatedInputTokens).toBeLessThanOrEqual(tight.maxInputTokens);
    for (const b of plan.batches) {
      expect(b.diffChars + OVERHEAD).toBeLessThanOrEqual(tight.batchInputTokens * CHARS_PER_TOKEN);
    }
    const coverage = buildCoverage({
      plan,
      outcomes: allSucceeded(plan),
      findings: noFindings,
      riskFor: () => 'unknown',
      usageUnits: 1,
    });
    expect(coverage.counts.deferred_budget).toBeGreaterThan(0);
    expect(coverage.counts.reviewed_full + coverage.counts.deferred_budget).toBe(300);
    expect(coverage.complete).toBe(false);
  });

  it('splits an oversized file across chunks, reviews what fits and records the rest as partial', () => {
    const huge = makePatch(6_000, { width: 60 }); // ~370k chars, more than all batches hold
    const plan = planPrReview({
      files: [makeFile('apps/api/src/auth/huge.ts', huge), makeFile('src/small.ts', makePatch(10))],
      totalFiles: 2,
      source: 'github_api',
      overheadChars: OVERHEAD,
      limits: limits(),
    });
    const hugeFile = plan.files.find((f) => f.path.endsWith('huge.ts'))!;
    expect(hugeFile.chunks.length).toBeGreaterThan(3);
    // The small file is not starved by the huge one (per-file share), and is planned.
    expect(plan.files.find((f) => f.path === 'src/small.ts')!.plannedChunks).toEqual([0]);
    const coverage = buildCoverage({
      plan,
      outcomes: allSucceeded(plan),
      findings: noFindings,
      riskFor: () => 'unknown',
      usageUnits: 1,
    });
    const huge2 = coverage.files.find((f) => f.path.endsWith('huge.ts'))!;
    expect(huge2.status).toBe('reviewed_partial');
    expect(huge2.reviewedChars).toBeGreaterThan(0);
    expect(huge2.reviewedChars).toBeLessThan(huge2.patchChars);
  });

  it('counts files beyond the GitHub listing as not_fetched', () => {
    const files = Array.from({ length: 10 }, (_, i) => makeFile(`src/f${i}.ts`, makePatch(2)));
    const plan = planPrReview({
      files,
      totalFiles: 1_250,
      source: 'github_api',
      overheadChars: OVERHEAD,
      limits: limits(),
    });
    expect(plan.notFetched).toBe(1_240);
    const coverage = buildCoverage({
      plan,
      outcomes: allSucceeded(plan),
      findings: noFindings,
      riskFor: () => 'unknown',
      usageUnits: 1,
    });
    expect(coverage.counts.not_fetched).toBe(1_240);
    expect(coverage.complete).toBe(false);
    expect(scopeFromPlan(plan)).toMatchObject({
      totalFiles: 1_250,
      analyzedFiles: 10,
      skippedFiles: 1_240,
      truncated: true,
    });
  });

  it('marks files of failed batches review_failed and the review incomplete', () => {
    const files = Array.from({ length: 40 }, (_, i) =>
      makeFile(`src/f${i}.ts`, makePatch(55, { tag: `f${i}_` })),
    );
    const plan = planPrReview({
      files,
      totalFiles: 40,
      source: 'github_api',
      overheadChars: OVERHEAD,
      limits: limits(),
    });
    expect(plan.batches.length).toBeGreaterThanOrEqual(2);
    const outcomes = plan.batches.map((b, i) => ({
      id: b.id,
      status: i === 0 ? ('failed' as const) : ('succeeded' as const),
      attempts: i === 0 ? 2 : 1,
      files: b.units.length,
    }));
    const coverage = buildCoverage({
      plan,
      outcomes,
      findings: noFindings,
      riskFor: () => 'unknown',
      usageUnits: 1,
    });
    expect(coverage.counts.review_failed).toBe(plan.batches[0]!.units.length);
    expect(coverage.complete).toBe(false);
  });

  it('page-fallback excerpts are never counted as fully reviewed', () => {
    const plan = planPrReview({
      files: [makeFile('src/a.ts', '+excerpt line')],
      totalFiles: null,
      source: 'page',
      overheadChars: OVERHEAD,
      limits: limits(),
    });
    const coverage = buildCoverage({
      plan,
      outcomes: allSucceeded(plan),
      findings: noFindings,
      riskFor: () => 'unknown',
      usageUnits: 1,
    });
    expect(coverage.files[0]!.status).toBe('reviewed_partial');
    expect(coverage.complete).toBe(false);
  });

  it('a fully covered PR is complete', () => {
    const plan = planPrReview({
      files: [makeFile('src/a.ts', makePatch(3)), makeFile('yarn.lock', makePatch(3))],
      totalFiles: 2,
      source: 'github_api',
      overheadChars: OVERHEAD,
      limits: limits(),
    });
    const coverage = buildCoverage({
      plan,
      outcomes: allSucceeded(plan),
      findings: noFindings,
      riskFor: () => 'low',
      usageUnits: 1,
    });
    expect(coverage.complete).toBe(true);
    expect(coverage.counts).toMatchObject({ reviewed_full: 1, excluded_generated: 1 });
  });

  it('clamps hand-built limits into the hard ceilings', () => {
    const l = sanitizeLimits({
      maxBatches: 999,
      concurrency: 50,
      batchInputTokens: 1e9,
      maxInputTokens: 1e9,
    });
    expect(l).toMatchObject({
      maxBatches: 12,
      concurrency: 6,
      batchInputTokens: 60_000,
      maxInputTokens: 400_000,
    });
  });
});
