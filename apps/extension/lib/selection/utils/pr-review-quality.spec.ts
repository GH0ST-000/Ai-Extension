import { describe, expect, it } from 'vitest';
import type { PRReviewCoverage, PageContext } from '@project-x/types';

import { buildPrReviewReport } from './build-pr-review-report';
import { buildPrReviewCommentDraft, formatPrReviewMarkdown } from './format-pr-review-markdown';
import { parsePrReviewContent } from './parse-pr-review';
import { decodePrReviewCoverage } from './pr-review-coverage';

const CONTEXT: PageContext = {
  type: 'github',
  url: 'https://github.com/acme/app/pull/9',
  title: 'PR',
  github: { owner: 'acme', repository: 'app', pullRequestNumber: 9 },
};

const encode = (c: unknown) => Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
const COVERAGE: PRReviewCoverage = {
  version: 1,
  source: 'github_api',
  totalFiles: 2,
  complete: true,
  counts: {
    reviewed_full: 2,
    reviewed_partial: 0,
    excluded_generated: 0,
    excluded_binary: 0,
    excluded_no_changes: 0,
    deferred_budget: 0,
    no_patch: 0,
    not_fetched: 0,
    review_failed: 0,
  },
  files: [],
  batches: [{ id: 'b1', status: 'succeeded', attempts: 1, files: 2 }],
  findings: {
    accepted: 1,
    duplicates: 0,
    rejected: 2,
    rejectedByReason: { trivial_evidence: 2 },
    linesCorrected: 0,
    needsInvestigation: 1,
    dismissed: 1,
    crossFileMerged: 0,
    severityAdjusted: 1,
    verification: {
      attempted: 3,
      confirmed: 1,
      refuted: 1,
      insufficientContext: 1,
      unavailable: 0,
    },
  },
  riskLevel: 'unknown',
  usageUnits: 1,
};

const SERVER = [
  '## Summary',
  'Coverage: 2 of 2 changed files fully reviewed. Reported findings: 1 (0 high, 1 medium, 0 low).',
  '',
  '## Risk Findings',
  '1. **[medium]** `src/memory.ts` — Archived rows still counted toward the limit',
  '   Why: count() ignores status.',
  '   Category: correctness · Confidence: high',
  '   Verification: confirmed by independent verification — count at memory.ts:40 has no status filter.',
  '   Trigger: A workspace with 50 archived rules creates a new rule',
  '   Failure path: createRule → assertCanCreate (memory.ts:40) counts archived rows → limit error',
  '   Impact: Users cannot add rules after archiving old ones',
  '   Lines: L40 (model cited L400, which is not in the reviewed diff)',
  '   Also in: `src/limits.ts`',
  '   Ref: prf_aaaaaaaaaaaaaaaa',
  '   Evidence:',
  '   │ const total = await this.prisma.memory.count({ where: { userId } });',
  '',
  '## Needs Investigation',
  '1. **[high]** `src/auth.ts` — Guard may be bypassed by the legacy route',
  '   Why: The legacy route is not shown.',
  '   Category: security · Confidence: medium',
  '   Verification: insufficient context to confirm or refute — LegacyController not provided.',
  '   Missing context: LegacyController.handle',
  '   Ref: prf_bbbbbbbbbbbbbbbb',
  '   Evidence:',
  '   │ if (!this.guard.allows(user)) throw new ForbiddenException();',
  '',
  `[[px:review-coverage ${encode(COVERAGE)}]]`,
].join('\n');

describe('verified findings vs Needs Investigation', () => {
  it('parses the two sections separately with their structured fields', () => {
    const parsed = parsePrReviewContent(SERVER);
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.investigation).toHaveLength(1);
    expect(parsed.findings[0]).toMatchObject({
      ref: 'prf_aaaaaaaaaaaaaaaa',
      category: 'correctness',
      confidence: 'high',
      lineStart: 40,
      lineEnd: 40,
      trigger: 'A workspace with 50 archived rules creates a new rule',
      impact: 'Users cannot add rules after archiving old ones',
      alsoIn: ['src/limits.ts'],
    });
    expect(parsed.findings[0]!.verification).toMatch(/^confirmed by independent verification/);
    expect(parsed.investigation[0]).toMatchObject({
      severity: 'high',
      category: 'security',
      ref: 'prf_bbbbbbbbbbbbbbbb',
    });
  });

  it('counts only verified findings, keeps candidates visible, and is not LOW/MEDIUM while they are open', () => {
    const report = buildPrReviewReport({ markdown: SERVER, context: CONTEXT, final: true })!;
    expect(report.stats.findings).toBe(1);
    expect(report.findings.map((f) => f.id)).toEqual(['prf_aaaaaaaaaaaaaaaa']);
    expect(report.needsInvestigation?.map((f) => f.id)).toEqual(['prf_bbbbbbbbbbbbbbbb']);
    expect(report.riskLevel).toBe('unknown'); // server risk
    expect(report.completeness?.complete).toBe(true);
  });

  it('exports the anchored evidence line, never the line the model cited', () => {
    const report = buildPrReviewReport({ markdown: SERVER, context: CONTEXT, final: true })!;
    expect(report.findings[0]).toMatchObject({ lineStart: 40, lineEnd: 40 });
    const md = formatPrReviewMarkdown(report);
    expect(md).toContain('   Lines: L40');
    expect(md).not.toContain('L400');
  });

  it('without a server risk, an open serious candidate still prevents LOW', () => {
    const noTrailer = SERVER.replace(/\n\[\[px:review-coverage [^\]]+\]\]/, '').replace(
      /1\. \*\*\[medium\]\*\*/,
      '1. **[low]**',
    );
    const report = buildPrReviewReport({ markdown: noTrailer, context: CONTEXT, final: true })!;
    expect(report.findings[0]!.severity).toBe('low');
    expect(report.riskLevel).toBe('unknown');
  });

  it('legacy reviews with "###" sub-headings inside Risk Findings keep all findings', () => {
    const legacy = [
      '## Summary',
      'Two issues.',
      '## Risk Findings',
      '### Backend',
      '1. **[high]** `api.ts` — SQL injection',
      '   Why: raw query',
      '### Frontend',
      '2. **[low]** `ui.tsx` — Missing alt text',
      '   Why: a11y',
    ].join('\n');
    expect(parsePrReviewContent(legacy).findings.map((f) => f.title)).toEqual([
      'SQL injection',
      'Missing alt text',
    ]);
  });

  it('exports both sections and the draft comment mentions open candidates', () => {
    const report = buildPrReviewReport({ markdown: SERVER, context: CONTEXT, final: true })!;
    const md = formatPrReviewMarkdown(report);
    expect(md).toContain('## Needs Investigation');
    expect(md).toContain('Guard may be bypassed by the legacy route');
    expect(md).toContain('   Trigger: A workspace with 50 archived rules creates a new rule');
    expect(md).toContain('   Verification: confirmed by independent verification');
    const draft = buildPrReviewCommentDraft(report);
    expect(draft).toContain('1 possible issue still need investigation');
    expect(draft).not.toContain('Guard may be bypassed');
  });

  it('decodes the new verification statistics strictly', () => {
    const decoded = decodePrReviewCoverage(encode(COVERAGE))!;
    expect(decoded.findings).toMatchObject({
      needsInvestigation: 1,
      dismissed: 1,
      verification: { attempted: 3, refuted: 1 },
    });
    const bad = decodePrReviewCoverage(
      encode({ ...COVERAGE, findings: { ...COVERAGE.findings, verification: { attempted: -1 } } }),
    )!;
    expect(bad.findings.verification).toBeUndefined();
  });
});

describe('change type and verification context (live review #2 fixes)', () => {
  const md = (change: string) =>
    [
      '## Summary',
      'x',
      '## Risk Findings',
      '1. **[high]** `src/rules.ts` — deleteRule no longer authorizes the caller',
      '   Why: The guard was removed.',
      '   Category: security · Confidence: high',
      `   Change: ${change}`,
      '   Verification: confirmed by independent verification',
      '   Ref: prf_cccccccccccccccc',
    ].join('\n');

  it.each([
    ['safeguard removed by this PR', 'removed_safeguard'],
    ['existing defect exposed by this PR', 'exposed_existing'],
    ['pre-existing, not introduced by this PR', 'pre_existing'],
    ['introduced by this PR', 'introduced'],
  ])('parses "%s"', (label, expected) => {
    const report = buildPrReviewReport({ markdown: md(label), context: CONTEXT, final: true })!;
    expect(report.findings[0]!.changeType).toBe(expected);
    expect(formatPrReviewMarkdown(report)).toContain(`   Change: ${expected.replace(/_/g, ' ')}`);
  });

  it('ignores an unknown change label instead of guessing', () => {
    const report = buildPrReviewReport({
      markdown: md('something else'),
      context: CONTEXT,
      final: true,
    })!;
    expect(report.findings[0]!.changeType).toBeUndefined();
  });

  it('decodes verification-context counters', () => {
    const c = {
      ...COVERAGE,
      findings: {
        ...COVERAGE.findings,
        verification: {
          ...COVERAGE.findings.verification!,
          withDiffWindow: 3,
          withHeadContext: 3,
          withHelpers: 1,
          unprovenConfirmations: 2,
        },
      },
    };
    expect(decodePrReviewCoverage(encode(c))!.findings.verification).toMatchObject({
      withDiffWindow: 3,
      withHeadContext: 3,
      withHelpers: 1,
      unprovenConfirmations: 2,
    });
  });
});
