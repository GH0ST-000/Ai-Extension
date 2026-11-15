import { zodSchema } from 'ai';
import { describe, expect, it } from 'vitest';
import type { PRReviewCoverage } from '@project-x/types';

import { chunkPatch, isSubstantiveCode } from './diff-hunks';
import {
  applyVerification,
  batchOutputSchema,
  computeRiskLevel,
  groupSameRootCause,
  mergeFindings,
  verificationOrder,
  stableFindingId,
  validateBatchFindings,
  type BatchFindingInput,
} from './pr-review-findings';
import { rawFinding, validatedFinding } from './pr-review-fixtures';
import type { PlannedBatch } from './pr-review-plan';
import { buildOverview, coverageSentence, renderPrReview } from './pr-review-render';

/** Real-looking hunk: context, a guard, an added unscoped query, a removed scoped query. */
const PATCH = [
  '@@ -10,7 +10,8 @@ export class MemoryService {',
  '   async list(userId: string, workspaceId: string) {',
  '     const member = await this.authorize(userId, workspaceId);',
  '-    return this.prisma.projectMemory.findMany({ where: { workspaceId } });',
  '+    const rows = await this.prisma.projectMemory.findMany({ where: {} });',
  '+    return rows.map(toItem);',
  '   }',
  ' ',
  '   });',
].join('\n');
const batch: PlannedBatch = {
  id: 'b1',
  diffChars: PATCH.length,
  units: [{ path: 'src/a.ts', chunkIndex: 0, chunkCount: 1, chunk: chunkPatch(PATCH, 10_000)[0]! }],
};
const ADDED = 'const rows = await this.prisma.projectMemory.findMany({ where: {} });';
const f = (over: Partial<BatchFindingInput> = {}) => rawFinding({ evidence: ADDED, ...over });
const validate = (findings: BatchFindingInput[]) =>
  validateBatchFindings({ summary: 's', findings }, batch);

describe('evidence validation', () => {
  it('accepts substantive evidence on a changed line and anchors it', () => {
    const r = validate([f()]);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({
      path: 'src/a.ts',
      lineStart: 12,
      lineEnd: 12,
      evidenceKind: 'changed',
    });
  });

  it.each([['./src/a.ts'], ['b/src/a.ts'], ['`src/a.ts`']])('normalizes path %s', (path) => {
    expect(validate([f({ path })]).findings[0]!.path).toBe('src/a.ts');
  });

  it('rejects invented paths and files outside the batch', () => {
    const r = validate([f({ path: 'src/other.ts' }), f({ path: 'src/a.ts.bak' })]);
    expect(r.findings).toEqual([]);
    expect(r.rejectedByReason).toEqual({ path_not_in_batch: 2 });
  });

  it('rejects evidence that is not in the reviewed diff', () => {
    expect(validate([f({ evidence: 'db.dropAllTables()' })]).rejectedByReason).toEqual({
      evidence_not_in_diff: 1,
    });
  });

  it.each([
    ['});', 'trivial_evidence'],
    ['return', 'trivial_evidence'],
    ['   }\n });', 'trivial_evidence'],
    ['where: {} });', 'trivial_evidence'],
    ['}', 'evidence_not_in_diff'], // shorter than any checkable quote
    ['return rows;', 'evidence_not_in_diff'],
  ])('rejects %j (%s) even when it occurs inside a real changed line', (evidence, reason) => {
    expect(validate([f({ evidence })]).rejectedByReason).toEqual({ [reason]: 1 });
  });

  it('a trivial line next to a substantive context quote does not make it "changed" evidence', () => {
    const r = validate([
      f({ evidence: 'const member = await this.authorize(userId, workspaceId);\n});' }),
    ]);
    expect(r.findings[0]!.evidenceKind).toBe('context');
  });

  it('substantive-code check', () => {
    expect(isSubstantiveCode('});')).toBe(false);
    expect(isSubstantiveCode('return null;')).toBe(false);
    expect(isSubstantiveCode('} else {')).toBe(false);
    expect(isSubstantiveCode('return rows.map(toItem);')).toBe(true);
  });

  it('deleted lines: valid only as a removed safeguard, anchored to the head line that follows', () => {
    const removed = '-    return this.prisma.projectMemory.findMany({ where: { workspaceId } });';
    // A deleted scoped query labelled "introduced" is a removed safeguard (the diff decides).
    const relabelled = validate([f({ evidence: removed })]);
    expect(relabelled.rejectedByReason).toEqual({});
    expect(relabelled.findings[0]).toMatchObject({ changeType: 'removed_safeguard' });
    expect(relabelled.findings[0]!.gateNotes).toContain('change_type_corrected');
    const r = validate([f({ evidence: removed, changeType: 'removed_safeguard' })]);
    expect(r.findings[0]).toMatchObject({
      evidenceKind: 'changed',
      changeType: 'removed_safeguard',
      lineStart: 12,
      headLine: 12, // the added replacement line at the head
      disposition: 'needs_investigation',
    });
  });

  it('a removed-safeguard claim that quotes no deleted line is judged as introduced', () => {
    const r = validate([f({ changeType: 'removed_safeguard' })]);
    expect(r.findings[0]).toMatchObject({ changeType: 'introduced' });
    expect(r.findings[0]!.gateNotes).toContain('change_type_corrected');
  });

  it('context-only evidence: a serious "introduced" claim becomes an exposed-existing candidate (severity kept)', () => {
    const contextQuote = 'const member = await this.authorize(userId, workspaceId);';
    const introduced = validate([f({ evidence: contextQuote })]);
    expect(introduced.findings[0]).toMatchObject({
      changeType: 'exposed_existing',
      severity: 'high',
      evidenceKind: 'context',
      confidence: 'medium',
      disposition: 'needs_investigation',
    });
    expect(introduced.findings[0]!.gateNotes).toContain('reclassified_exposed_existing');
    // Low-value noise about unchanged code is rejected…
    const lowNoise = validate([
      f({ evidence: contextQuote, severity: 'low', category: 'robustness' }),
    ]);
    expect(lowNoise.rejectedByReason).toEqual({ context_only_low: 1 });
    // …but an explicitly pre-existing note is kept, capped at LOW, and labelled.
    const pre = validate([f({ evidence: contextQuote, changeType: 'pre_existing' })]);
    expect(pre.findings[0]).toMatchObject({
      changeType: 'pre_existing',
      severity: 'low',
      disposition: 'reported',
    });
    expect(pre.findings[0]!.gateNotes).toContain('pre_existing_cap');
  });

  it('observability is capped at LOW and needs no verification', () => {
    const r = validate([f({ category: 'observability', severity: 'medium' })]);
    expect(r.findings[0]).toMatchObject({ severity: 'low', disposition: 'reported' });
  });

  it('records (never silently rewrites) an out-of-diff line reference', () => {
    const r = validate([f({ lineStart: 4_000, lineEnd: 4_010 })]);
    expect(r.findings[0]).toMatchObject({
      lineStart: 12,
      lineEnd: 12,
      claimedLines: { start: 4_000, end: 4_010 },
      confidence: 'medium',
    });
    expect(r.findings[0]!.gateNotes).toContain('line_mismatch');
    expect(r.linesCorrected).toBe(1);
  });

  it('a claimed line inside the diff that does not contain the evidence is re-anchored and recorded', () => {
    // L14 is the closing brace in the same hunk (live review #4: claimed L42, quoted L29).
    const r = validate([f({ lineStart: 14, lineEnd: 14 })]);
    expect(r.findings[0]).toMatchObject({
      lineStart: 12,
      lineEnd: 12,
      headLine: 12,
      claimedLines: { start: 14, end: 14 },
    });
    expect(r.findings[0]!.gateNotes).toContain('line_mismatch');
    expect(r.linesCorrected).toBe(1);
  });

  it('a claimed range that contains the evidence is kept', () => {
    const r = validate([f({ lineStart: 11, lineEnd: 13 })]);
    expect(r.findings[0]).toMatchObject({ lineStart: 11, lineEnd: 13, claimedLines: null });
    expect(r.linesCorrected).toBe(0);
  });

  it('a claimed line inside multi-line evidence anchors to the whole evidence (not a mismatch)', () => {
    const r = validate([
      f({ evidence: `${ADDED}\nreturn rows.map(toItem);`, lineStart: 13, lineEnd: 13 }),
    ]);
    expect(r.findings[0]).toMatchObject({ lineStart: 12, lineEnd: 13, claimedLines: null });
    expect(r.findings[0]!.gateNotes).not.toContain('line_mismatch');
  });

  it('Gate A: "pre_existing" on ADDED code is corrected to introduced — no LOW cap, verified', () => {
    const r = validate([
      f({ severity: 'medium', category: 'availability', changeType: 'pre_existing' }),
    ]);
    expect(r.findings[0]).toMatchObject({
      changeType: 'introduced',
      severity: 'medium',
      disposition: 'needs_investigation',
      verification: { status: 'pending' },
    });
    expect(r.findings[0]!.gateNotes).toContain('change_type_corrected');
    expect(r.findings[0]!.gateNotes).not.toContain('pre_existing_cap');
    expect(r.changeTypeCorrections).toBe(1);
  });

  it('Gate A: a genuine pre-existing finding on unchanged code keeps its label (capped LOW)', () => {
    const r = validate([
      f({
        severity: 'medium',
        changeType: 'pre_existing',
        evidence: 'const member = await this.authorize(userId, workspaceId);',
      }),
    ]);
    expect(r.findings[0]).toMatchObject({ changeType: 'pre_existing', severity: 'low' });
    expect(r.changeTypeCorrections).toBe(0);
  });

  it('Gate D: a containing but over-wide range is narrowed to the evidence (not a mismatch)', () => {
    const r = validate([f({ lineStart: 10, lineEnd: 40 })]);
    expect(r.findings[0]).toMatchObject({ lineStart: 12, lineEnd: 12, claimedLines: null });
    expect(r.findings[0]!.gateNotes).toContain('line_range_narrowed');
    expect(r.findings[0]!.gateNotes).not.toContain('line_mismatch');
    expect(r.rangesNarrowed).toBe(1);
  });

  it('Gate D: evidence spanning several legitimate lines keeps a tight claimed range', () => {
    const r = validate([
      f({ evidence: `${ADDED}\nreturn rows.map(toItem);`, lineStart: 11, lineEnd: 14 }),
    ]);
    expect(r.findings[0]).toMatchObject({ lineStart: 11, lineEnd: 14, claimedLines: null });
    expect(r.rangesNarrowed).toBe(0);
  });

  it('caps findings per batch', () => {
    const many = Array.from({ length: 35 }, (_, i) => f({ title: `Issue ${i}` }));
    const r = validate(many);
    expect(r.findings).toHaveLength(30);
    expect(r.rejectedByReason).toEqual({ over_limit: 5 });
  });
});

describe('deterministic severity gates', () => {
  it.each([
    ['test_gap', 'high', 'low'],
    ['maintainability', 'high', 'low'],
    ['correctness', 'high', 'medium'],
    ['robustness', 'high', 'medium'],
    ['security', 'high', 'high'],
    ['data_integrity', 'high', 'high'],
  ] as const)('%s requested %s → at most %s', (category, requested, expected) => {
    const r = validate([f({ category, severity: requested })]);
    expect(r.findings[0]).toMatchObject({ requestedSeverity: requested, severity: expected });
    if (expected !== requested) expect(r.findings[0]!.gateNotes).toContain('category_cap');
  });

  it('a memory-forced HIGH on a non-critical concern cannot stay HIGH', () => {
    const r = validate([
      f({
        category: 'maintainability',
        severity: 'high',
        title: 'Project Memory rule: isolation must be verified',
        trigger: '',
        failurePath: '',
      }),
    ]);
    expect(r.findings[0]).toMatchObject({ severity: 'low', disposition: 'reported' });
  });

  it('a HIGH security claim without a failure path is kept as a HIGH candidate, never reported unverified', () => {
    const r = validate([f({ trigger: '', failurePath: 'maybe', impact: '' })]);
    expect(r.findings[0]).toMatchObject({
      severity: 'high',
      disposition: 'needs_investigation',
      verification: { status: 'pending' },
    });
    expect(r.findings[0]!.gateNotes).toContain('unsupported_failure_path');
  });

  it('every MEDIUM/HIGH needs verification; a LOW runtime claim is reported but checked with spare capacity', () => {
    const r = validate([
      f({ severity: 'medium', category: 'correctness', title: 'A' }),
      f({ severity: 'low', category: 'robustness', title: 'B' }),
      f({ severity: 'low', category: 'maintainability', title: 'C' }),
    ]);
    expect(r.findings.map((x) => [x.severity, x.disposition, x.verification.status])).toEqual([
      ['medium', 'needs_investigation', 'pending'],
      ['low', 'reported', 'pending'], // optional check: confirm, dismiss, or UNVERIFIED
      ['low', 'reported', 'not_required'],
    ]);
  });
});

describe('verification outcomes', () => {
  const candidate = validatedFinding({
    severity: 'high',
    category: 'security',
    disposition: 'needs_investigation',
    verification: { status: 'pending' },
  });

  it('confirmed → reported; the verifier may lower but never raise severity', () => {
    expect(
      applyVerification(candidate, { verdict: 'confirmed', severity: 'medium', reason: 'r' }),
    ).toMatchObject({
      disposition: 'reported',
      severity: 'medium',
      verification: { status: 'confirmed' },
    });
    const med = { ...candidate, severity: 'medium' as const };
    expect(
      applyVerification(med, { verdict: 'confirmed', severity: 'high', reason: 'r' }).severity,
    ).toBe('medium');
  });

  it('refuted → dismissed (kept and counted); insufficient/unavailable → needs investigation', () => {
    expect(applyVerification(candidate, { verdict: 'refuted', reason: 'guard' }).disposition).toBe(
      'dismissed',
    );
    expect(
      applyVerification(candidate, { verdict: 'insufficient_context', reason: 'x' }).disposition,
    ).toBe('needs_investigation');
    expect(applyVerification(candidate, { verdict: 'unavailable', reason: 'x' }).disposition).toBe(
      'needs_investigation',
    );
  });
});

describe('mergeFindings', () => {
  const prio = new Map([
    ['src/a.ts', 60],
    ['src/auth.ts', 90],
    ['src/b.ts', 60],
  ]);

  it('drops same-file duplicates and keeps the highest severity', () => {
    const r = mergeFindings(
      [
        validatedFinding(),
        validatedFinding({
          batchId: 'b2',
          title: 'Unchecked result.',
          severity: 'high',
          category: 'security',
        }),
      ],
      prio,
      ['b1', 'b2'],
    );
    expect(r.duplicates).toBe(1);
    expect(r.findings.map((x) => x.severity)).toEqual(['high']);
  });

  it('keeps distinct issues on the same file', () => {
    const r = mergeFindings(
      [
        validatedFinding(),
        validatedFinding({
          ordinal: 1,
          title: 'SQL built from input',
          lineStart: 118,
          lineEnd: 118,
          evidence: "const v118 = compute('v', 118);",
          violatedInvariant: 'queries are parameterized',
        }),
      ],
      prio,
      ['b1'],
    );
    expect(r.findings).toHaveLength(2);
  });

  describe('same root cause across files (regression: never merge before verification)', () => {
    const occurrence = (path: string, batchId: string, over = {}) =>
      validatedFinding({
        path,
        batchId,
        category: 'security',
        severity: 'high',
        title: 'Workspace isolation is not enforced for memory reads',
        violatedInvariant: 'Memory reads must be scoped to the acting workspace',
        disposition: 'needs_investigation',
        verification: { status: 'pending' },
        ...over,
      });

    it('mergeFindings keeps each file as its own candidate', () => {
      const r = mergeFindings(
        [
          occurrence('src/a.ts', 'b1'),
          occurrence('src/b.ts', 'b2'),
          occurrence('src/auth.ts', 'b3'),
        ],
        prio,
        ['b1', 'b2', 'b3'],
      );
      expect(r.findings.map((f) => f.path).sort()).toEqual(['src/a.ts', 'src/auth.ts', 'src/b.ts']);
      expect(r.findings.every((f) => f.alsoIn.length === 0)).toBe(true);
    });

    it('refuting one file never hides another file; confirmed is never listed under refuted', () => {
      const merged = mergeFindings(
        [occurrence('src/auth.ts', 'b1'), occurrence('src/b.ts', 'b2')],
        prio,
        ['b1', 'b2'],
      ).findings;
      const verified = merged.map((f) =>
        f.path === 'src/auth.ts'
          ? applyVerification(f, { verdict: 'refuted', reason: 'guard present' })
          : applyVerification(f, { verdict: 'confirmed', severity: 'high', reason: 'no filter' }),
      );
      const grouped = groupSameRootCause(verified, prio);
      expect(grouped.crossFileMerged).toBe(0);
      const byPath = Object.fromEntries(
        grouped.findings.map((f) => [f.path, [f.disposition, f.alsoIn]]),
      );
      expect(byPath).toEqual({ 'src/b.ts': ['reported', []], 'src/auth.ts': ['dismissed', []] });
    });

    it('groups only occurrences with the same verified outcome and severity', () => {
      const verified = [
        applyVerification(occurrence('src/auth.ts', 'b1'), {
          verdict: 'confirmed',
          severity: 'high',
          reason: 'x',
        }),
        applyVerification(occurrence('src/a.ts', 'b2'), {
          verdict: 'confirmed',
          severity: 'high',
          reason: 'x',
        }),
        applyVerification(occurrence('src/b.ts', 'b3'), {
          verdict: 'insufficient_context',
          reason: 'x',
        }),
      ];
      const grouped = groupSameRootCause(verified, prio);
      expect(grouped.crossFileMerged).toBe(1);
      expect(grouped.findings.map((f) => [f.path, f.disposition, f.alsoIn])).toEqual([
        ['src/auth.ts', 'reported', ['src/a.ts']],
        ['src/b.ts', 'needs_investigation', []],
      ]);
    });

    it('distinct defects that share a generic invariant are NOT grouped (titles differ)', () => {
      const confirmed = (path: string, title: string) =>
        applyVerification(
          occurrence(path, 'b1', { title, violatedInvariant: 'Only authorized users can do this' }),
          { verdict: 'confirmed', severity: 'high', reason: 'x' },
        );
      const grouped = groupSameRootCause(
        [
          confirmed('src/a.ts', 'Export returns every workspace'),
          confirmed('src/b.ts', 'Delete rule no longer authorizes'),
        ],
        prio,
      );
      expect(grouped.crossFileMerged).toBe(0);
      expect(grouped.findings).toHaveLength(2);
    });

    it('verifies the first occurrence of each pattern before its repeats', () => {
      const other = validatedFinding({
        path: 'src/z.ts',
        category: 'security',
        severity: 'high',
        title: 'Deletion is not scoped to the workspace',
        violatedInvariant: 'Deletes affect only the acting workspace',
        disposition: 'needs_investigation',
        verification: { status: 'pending' },
      });
      const order = verificationOrder(
        mergeFindings(
          [
            occurrence('src/auth.ts', 'b1'),
            occurrence('src/a.ts', 'b2'),
            occurrence('src/b.ts', 'b3'),
            other,
          ],
          prio,
          ['b1', 'b2', 'b3'],
        ).findings,
        prio,
      ).map((f) => f.path);
      expect(order.slice(0, 2).sort()).toEqual(['src/auth.ts', 'src/z.ts']);
    });
  });

  it('assigns stable ids independent of batch order', () => {
    const a = validatedFinding();
    const b = validatedFinding({
      path: 'src/auth.ts',
      title: 'Missing tenant check',
      evidence: 'x1 y2 z3 w4',
    });
    const one = mergeFindings([a, b], prio, ['b1']).findings;
    const two = mergeFindings(
      [
        { ...b, batchId: 'b9' },
        { ...a, batchId: 'b3' },
      ],
      prio,
      ['b3', 'b9'],
    ).findings;
    expect(one.map((x) => x.stableId)).toEqual(two.map((x) => x.stableId));
    expect(one[0]!.stableId).toBe(stableFindingId(b));
    expect(one[0]!.stableId).toMatch(/^prf_[0-9a-f]{16}$/);
  });
});

describe('computeRiskLevel', () => {
  const r = (
    severity: 'high' | 'medium' | 'low',
    disposition: 'reported' | 'needs_investigation' | 'dismissed',
  ) => ({
    severity,
    disposition,
  });
  it.each([
    [[], true, 'low'],
    [[], false, 'unknown'],
    [[r('medium', 'reported')], true, 'medium'],
    [[r('medium', 'reported')], false, 'unknown'],
    [[r('high', 'reported')], false, 'high'],
    // Unresolved serious candidates: never LOW (or MEDIUM), even with full coverage.
    [[r('high', 'needs_investigation')], true, 'unknown'],
    [[r('medium', 'needs_investigation'), r('low', 'reported')], true, 'unknown'],
    // Refuted candidates do not count.
    [[r('high', 'dismissed')], true, 'low'],
    [[r('low', 'needs_investigation')], true, 'low'],
  ] as const)('%j complete=%s → %s', (findings, complete, expected) => {
    expect(computeRiskLevel(findings as never, complete)).toBe(expected);
  });
});

describe('batch output schema', () => {
  it('is strict structured-output compatible: every property required, no extras', async () => {
    const json = (await zodSchema(batchOutputSchema as never).jsonSchema) as {
      required: string[];
      additionalProperties: boolean;
      properties: {
        findings: {
          items: {
            required: string[];
            additionalProperties: boolean;
            properties: Record<string, unknown>;
          };
        };
      };
    };
    expect(json.required.sort()).toEqual(['findings', 'summary']);
    expect(json.additionalProperties).toBe(false);
    const item = json.properties.findings.items;
    expect(item.required.sort()).toEqual(Object.keys(item.properties).sort());
    expect(item.additionalProperties).toBe(false);
    for (const field of [
      'trigger',
      'failurePath',
      'violatedInvariant',
      'impact',
      'confidence',
      'assumptions',
      'missingContext',
      'category',
    ]) {
      expect(item.required).toContain(field);
    }
  });
});

describe('rendering', () => {
  const coverage = (over: Partial<PRReviewCoverage> = {}): PRReviewCoverage => ({
    version: 1,
    source: 'github_api',
    totalFiles: 3,
    complete: true,
    counts: {
      reviewed_full: 2,
      reviewed_partial: 0,
      excluded_generated: 1,
      excluded_binary: 0,
      excluded_no_changes: 0,
      deferred_budget: 0,
      no_patch: 0,
      not_fetched: 0,
      review_failed: 0,
    },
    files: [],
    batches: [{ id: 'b1', status: 'succeeded', attempts: 1, files: 2 }],
    findings: { accepted: 0, duplicates: 0, rejected: 0, rejectedByReason: {}, linesCorrected: 0 },
    riskLevel: 'low',
    usageUnits: 1,
    ...over,
  });

  it('says exactly what was reviewed', () => {
    expect(coverageSentence(coverage())).toBe(
      'Coverage: 2 of 3 changed files fully reviewed; 1 excluded (generated, binary or rename-only).',
    );
  });

  it('deterministic overview: counts and top risk, no batch summaries', () => {
    const findings = [
      validatedFinding({
        severity: 'high',
        category: 'security',
        title: 'Unscoped query',
        path: 'src/x.ts',
      }),
      validatedFinding({
        severity: 'medium',
        disposition: 'needs_investigation',
        verification: { status: 'insufficient_context' },
      }),
      validatedFinding({ disposition: 'dismissed', verification: { status: 'refuted' } }),
    ];
    expect(buildOverview(coverage(), findings)).toBe(
      'Coverage: 2 of 3 changed files fully reviewed; 1 excluded (generated, binary or rename-only). ' +
        'Reported findings: 1 (1 high, 0 medium, 0 low). ' +
        'Needs investigation: 1 candidate (0 high, 1 medium, 0 low) could not be confirmed or refuted — review them before treating this PR as low risk. ' +
        '1 candidate was refuted by independent verification. ' +
        'Top risk: [high] src/x.ts — Unscoped query.',
    );
  });

  it('separates reported findings from Needs Investigation; evidence never parses as a finding', () => {
    const text = renderPrReview({
      coverage: coverage(),
      findings: [
        validatedFinding({
          stableId: 'prf_0123456789abcdef',
          path: 'docs/steps.md',
          lineStart: 3,
          lineEnd: 4,
          severity: 'low',
          verification: { status: 'not_required' },
          evidence: '2. Deploy\n3. Migrate',
          claimedLines: { start: 90, end: 90 },
        }),
        validatedFinding({
          stableId: 'prf_fedcba9876543210',
          severity: 'high',
          category: 'security',
          disposition: 'needs_investigation',
          verification: {
            status: 'insufficient_context',
            reason: 'Caller of list() not provided.',
          },
          missingContext: 'MemoryController.list',
        }),
      ],
    });
    const [, afterFindings] = text.split('## Risk Findings\n');
    const [findingsBody, investigation] = afterFindings!.split('## Needs Investigation\n');
    expect(findingsBody!.match(/^\s*\d+[.)]\s/gm)).toHaveLength(1);
    expect(text).toContain('   │ 2. Deploy');
    expect(text).toContain(
      '   Lines: L3-L4 (model cited L90, which does not contain the quoted evidence)',
    );
    expect(text).toContain('   Verification: not required (low severity)');
    expect(investigation).toContain('**[high]**');
    expect(investigation).toContain(
      'Verification: insufficient context to confirm or refute — Caller of list() not provided.',
    );
    expect(investigation).toContain('Missing context: MemoryController.list');
  });

  it('partial coverage adds the incomplete marker last (older clients refuse LOW)', () => {
    const text = renderPrReview({
      coverage: coverage({ complete: false, riskLevel: 'unknown' }),
      findings: [],
    });
    expect(text.trimEnd().split('\n').at(-1)).toBe(
      '[[px:review-incomplete reason=partial-coverage]]',
    );
  });
});
