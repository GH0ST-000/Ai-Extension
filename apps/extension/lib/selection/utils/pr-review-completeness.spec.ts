import { describe, expect, it } from 'vitest';
import type { PageContext, PRReviewScope } from '@project-x/types';

import { parseReviewScopeHeader } from '../../services/ai-client';
import { buildPrReviewReport, formatReviewedFilesLabel } from './build-pr-review-report';
import { formatPrReviewMarkdown } from './format-pr-review-markdown';
import { parsePrReviewContent, stripIncompleteMarker } from './parse-pr-review';

const SCOPE: PRReviewScope = {
  source: 'github_api',
  totalFiles: 12,
  analyzedFiles: 9,
  skippedFiles: 3,
  truncated: true,
};

const CONTEXT: PageContext = {
  type: 'github',
  url: 'https://github.com/acme/app/pull/48',
  title: 'PR',
  github: { owner: 'acme', repository: 'app', pullRequestNumber: 48 },
};

const GOOD = [
  '## Summary',
  'Memory retrieval changes.',
  '## Risk Findings',
  '1. **[high]** `apps/api/src/project-memory/project-memory.service.ts` — Archived rules leak',
  '   Why: status filter removed.',
].join('\n');

describe('parsePrReviewContent', () => {
  it.each([
    ['1. **[high]** `a.ts` — Missing auth', 'high', 'a.ts', 'Missing auth'],
    ['1. [HIGH] `a.ts` - Missing auth', 'high', 'a.ts', 'Missing auth'],
    ['1) **Medium** `a.ts`: Weak check', 'medium', 'a.ts', 'Weak check'],
    ['2. **[med]** No path given', 'medium', null, 'No path given'],
    ['1. (low) `x/y.ts` — Nit', 'low', 'x/y.ts', 'Nit'],
  ])('parses %s', (header, severity, filePath, title) => {
    const parsed = parsePrReviewContent(`## Summary\ns\n## Risk Findings\n${header}\n   Why: w`);
    expect(parsed.unparsedFindingCount).toBe(0);
    expect(parsed.findings[0]).toMatchObject({ severity, filePath, title, why: 'w' });
  });

  it('does not read "1. Low coverage" as a low-severity finding', () => {
    const parsed = parsePrReviewContent(
      '## Summary\ns\n## Risk Findings\n1. Low coverage in tests',
    );
    expect(parsed.findings).toHaveLength(0);
    expect(parsed.unparsedFindingCount).toBe(1);
  });

  it('recognises an explicit no-risks statement', () => {
    const parsed = parsePrReviewContent(
      '## Summary\ns\n## Risk Findings\nNo material risks found.',
    );
    expect(parsed.explicitNoRisks).toBe(true);
  });

  it('strips the API incomplete trailer and keeps its reason', () => {
    expect(
      stripIncompleteMarker('## Summary\ncut\n\n[[px:review-incomplete reason=length]]'),
    ).toEqual({ text: '## Summary\ncut', incompleteReason: 'length' });
    expect(stripIncompleteMarker('plain').incompleteReason).toBeNull();
  });
});

describe('buildPrReviewReport completeness', () => {
  const build = (markdown: string, scope: PRReviewScope | null = SCOPE) =>
    buildPrReviewReport({ markdown, context: CONTEXT, scope, final: true })!;

  it('marks a well-formed review complete and reports N of M files', () => {
    const report = build(GOOD);
    expect(report.completeness).toEqual({ complete: true, reasons: [] });
    expect(report.riskLevel).toBe('high');
    expect(report.stats).toMatchObject({ analyzedFiles: 9, skippedFiles: 3, findings: 1 });
    expect(report.reviewScope).toMatchObject({
      totalFiles: 12,
      source: 'github_api',
      truncated: true,
    });
    expect(formatReviewedFilesLabel(report)).toBe('9 of 12 files reviewed');
  });

  it('accepts a clean "no material risks" review as complete', () => {
    const report = build('## Summary\nLooks fine.\n## Risk Findings\nNo material risks found.');
    expect(report.completeness?.complete).toBe(true);
    expect(report.stats.findings).toBe(0);
  });

  it('flags the PR #48 shape (generic overview, 0 files) as incomplete', () => {
    const report = build(
      '## Summary\nThe changed files list is empty. Please open the Files tab.\n## Risk Findings\nCannot assess.',
      { ...SCOPE, totalFiles: null, analyzedFiles: 0, skippedFiles: 0, truncated: false },
    );
    expect(report.completeness?.complete).toBe(false);
    expect(report.completeness?.reasons).toEqual(
      expect.arrayContaining([
        'No file diffs were reviewed.',
        'The Risk Findings section lists no findings and does not state "no risks".',
      ]),
    );
    expect(formatPrReviewMarkdown(report)).toContain('Risk level: **INCOMPLETE**');
  });

  it('flags output cut off by the token limit', () => {
    const report = build(
      `${GOOD}\n2. **[medium]** \`b.ts\` — Half\n\n[[px:review-incomplete reason=length]]`,
    );
    expect(report.completeness?.complete).toBe(false);
    expect(report.completeness?.reasons[0]).toMatch(/output limit/);
    expect(report.findings).toHaveLength(2);
  });

  it('flags missing Risk Findings, unstructured text, and unparseable findings', () => {
    expect(build('## Summary\nOnly a summary.').completeness?.reasons).toContain(
      'The response has no "Risk Findings" section.',
    );
    expect(build('Sorry, I cannot review this.').completeness?.complete).toBe(false);
    expect(
      build('## Summary\ns\n## Risk Findings\n1. Something odd happened').completeness?.reasons,
    ).toContain('1 finding could not be parsed (unexpected format).');
  });

  it('does not judge completeness while still streaming', () => {
    const report = buildPrReviewReport({
      markdown: '## Summary\npartial',
      context: CONTEXT,
      scope: SCOPE,
    });
    expect(report?.completeness).toBeUndefined();
  });

  it('without a server scope, counts only page files that carried diff text', () => {
    const report = buildPrReviewReport({
      markdown: GOOD,
      final: true,
      context: {
        ...CONTEXT,
        github: {
          ...CONTEXT.github,
          changedFiles: [{ path: 'a.ts', patchExcerpt: '+a' }, { path: 'b.ts' }],
        },
      },
    })!;
    expect(report.stats).toMatchObject({ analyzedFiles: 1, skippedFiles: 1 });
    expect(report.reviewScope?.source).toBe('page');
  });
});

describe('parseReviewScopeHeader', () => {
  it('parses a valid header and rejects malformed ones', () => {
    expect(parseReviewScopeHeader(JSON.stringify(SCOPE))).toEqual(SCOPE);
    expect(parseReviewScopeHeader(null)).toBeNull();
    expect(parseReviewScopeHeader('not json')).toBeNull();
    expect(parseReviewScopeHeader(JSON.stringify({ ...SCOPE, source: 'evil' }))).toBeNull();
    expect(parseReviewScopeHeader(JSON.stringify({ ...SCOPE, analyzedFiles: -1 }))).toBeNull();
  });
});
