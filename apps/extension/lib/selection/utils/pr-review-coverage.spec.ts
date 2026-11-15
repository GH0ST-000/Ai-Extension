import { describe, expect, it } from 'vitest';
import type { PRReviewCoverage, PRReviewScope, PageContext } from '@project-x/types';

import { buildPrReviewReport, formatReviewedFilesLabel } from './build-pr-review-report';
import { formatPrReviewMarkdown, buildPrReviewCommentDraft } from './format-pr-review-markdown';
import { parsePrReviewContent } from './parse-pr-review';
import {
  decodePrReviewCoverage,
  stripPrReviewTrailers,
  unreviewedFiles,
} from './pr-review-coverage';

const CONTEXT: PageContext = {
  type: 'github',
  url: 'https://github.com/acme/app/pull/7',
  title: 'PR',
  github: { owner: 'acme', repository: 'app', pullRequestNumber: 7 },
};

function coverage(over: Partial<PRReviewCoverage> = {}): PRReviewCoverage {
  return {
    version: 1,
    source: 'github_api',
    totalFiles: 61,
    complete: false,
    counts: {
      reviewed_full: 25,
      reviewed_partial: 1,
      excluded_generated: 1,
      excluded_binary: 1,
      excluded_no_changes: 0,
      deferred_budget: 30,
      no_patch: 1,
      not_fetched: 0,
      review_failed: 2,
    },
    files: [
      {
        path: 'apps/api/src/auth/session.ts',
        status: 'reviewed_full',
        priority: 90,
        patchChars: 900,
        reviewedChars: 900,
      },
      {
        path: 'apps/api/src/billing/reconcile.ts',
        status: 'no_patch',
        priority: 90,
        patchChars: 0,
        reviewedChars: 0,
      },
      {
        path: 'docs/guide.md',
        status: 'deferred_budget',
        priority: 10,
        patchChars: 500,
        reviewedChars: 0,
      },
      {
        path: 'src/big.ts',
        status: 'reviewed_partial',
        priority: 60,
        patchChars: 9000,
        reviewedChars: 4000,
      },
      {
        path: 'pnpm-lock.yaml',
        status: 'excluded_generated',
        priority: 0,
        patchChars: 100,
        reviewedChars: 0,
      },
    ],
    batches: [
      { id: 'b1', status: 'succeeded', attempts: 1, files: 20 },
      { id: 'b2', status: 'failed', attempts: 2, files: 2, errorCode: 'provider_error' },
    ],
    findings: {
      accepted: 1,
      duplicates: 1,
      rejected: 2,
      rejectedByReason: { path_not_in_batch: 2 },
      linesCorrected: 0,
    },
    riskLevel: 'unknown',
    usageUnits: 1,
    ...over,
  };
}

const encode = (c: unknown) => Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');

function serverResponse(c: PRReviewCoverage, findings = ''): string {
  return [
    '## Summary',
    'Coverage: 25 of 61 changed files fully reviewed; 30 deferred (review budget).',
    '',
    '## Risk Findings',
    findings ||
      'No material risks found in the reviewed files. Unreviewed files may still contain risks.',
    '',
    `[[px:review-coverage ${encode(c)}]]`,
    ...(c.complete ? [] : ['[[px:review-incomplete reason=partial-coverage]]']),
  ].join('\n');
}

const FINDING = [
  '1. **[medium]** `apps/api/src/auth/session.ts` — Session not rotated',
  '   Why: The session id is reused after login.',
  '   Lines: L40-L42',
  '   Ref: prf_0123456789abcdef',
  '   Evidence:',
  '   │ req.session.user = user;',
  '   │ 2. still evidence, not a finding',
].join('\n');

describe('coverage trailer', () => {
  it('ignores keep-alive newlines the API streams before the review', () => {
    const c = coverage({ complete: true, riskLevel: 'medium' });
    const plain = buildPrReviewReport({
      markdown: serverResponse(c, FINDING),
      context: CONTEXT,
      final: true,
    })!;
    const withHeartbeat = buildPrReviewReport({
      markdown: `\n\n\n\n${serverResponse(c, FINDING)}`,
      context: CONTEXT,
      final: true,
    })!;
    expect(withHeartbeat).toEqual(plain);
    // While only heartbeats have arrived there is no report yet (UI keeps "reviewing…").
    expect(buildPrReviewReport({ markdown: '\n\n', context: CONTEXT })).toBeNull();
  });

  it('the in-band failure body is an incomplete review, never clean', () => {
    const report = buildPrReviewReport({
      markdown:
        '\n\n## Summary\nThe PR review could not be completed: every AI review batch failed. No usage was charged. Try again in a moment.\n\n## Risk Findings\nNot reviewed.\n[[px:review-incomplete reason=error]]',
      context: CONTEXT,
      final: true,
    })!;
    expect(report.completeness?.complete).toBe(false);
    expect(report.riskLevel).toBe('unknown');
    expect(report.findings).toEqual([]);
  });

  it('strips both trailers in either order and decodes the manifest', () => {
    const c = coverage();
    const a = stripPrReviewTrailers(serverResponse(c));
    expect(a.incompleteReason).toBe('partial-coverage');
    expect(a.coverage).toEqual(c);
    expect(a.text).not.toContain('[[px:');

    const b = stripPrReviewTrailers(
      `body\n[[px:review-incomplete reason=length]]\n[[px:review-coverage ${encode(c)}]]`,
    );
    expect(b).toMatchObject({ text: 'body', incompleteReason: 'length' });
    expect(b.coverage).not.toBeNull();
  });

  it.each([
    [
      'unknown status',
      {
        files: [
          { path: 'a', status: 'skipped_quietly', priority: 1, patchChars: 0, reviewedChars: 0 },
        ],
      },
    ],
    ['negative count', { counts: { ...coverage().counts, deferred_budget: -1 } }],
    ['bad risk', { riskLevel: 'very low' }],
    ['bad version', { version: 2 }],
  ])('rejects a malformed manifest (%s)', (_label, over) => {
    expect(decodePrReviewCoverage(encode({ ...coverage(), ...over }))).toBeNull();
  });

  it('rejects non-base64 / non-JSON payloads', () => {
    expect(decodePrReviewCoverage('!!!')).toBeNull();
    expect(decodePrReviewCoverage(Buffer.from('not json').toString('base64url'))).toBeNull();
  });

  it('lists unreviewed files by priority, excluding intentional exclusions', () => {
    expect(unreviewedFiles(coverage()).map((f) => f.path)).toEqual([
      'apps/api/src/billing/reconcile.ts',
      'src/big.ts',
      'docs/guide.md',
    ]);
  });
});

describe('report from a batched server review', () => {
  const build = (markdown: string, scope: PRReviewScope | null = null) =>
    buildPrReviewReport({ markdown, context: CONTEXT, scope, final: true })!;

  it('partial coverage: never LOW, coverage counts win, not flagged as an incomplete answer', () => {
    const report = build(serverResponse(coverage()));
    expect(report.riskLevel).toBe('unknown');
    expect(report.completeness).toEqual({ complete: true, reasons: [] });
    expect(report.coverage?.complete).toBe(false);
    expect(report.stats).toMatchObject({ analyzedFiles: 26, skippedFiles: 35 });
    expect(report.reviewScope).toMatchObject({ truncated: true, totalFiles: 61 });
    expect(formatReviewedFilesLabel(report)).toBe('25 of 61 files fully reviewed (+1 partial)');
  });

  it('uses the server risk and stable finding ids, lines and evidence', () => {
    const c = coverage({ complete: true, riskLevel: 'medium' });
    const report = build(serverResponse(c, FINDING));
    expect(report.riskLevel).toBe('medium');
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({
      id: 'prf_0123456789abcdef',
      lineStart: 40,
      lineEnd: 42,
      evidence: 'req.session.user = user;\n2. still evidence, not a finding',
      filePath: 'apps/api/src/auth/session.ts',
    });
    expect(parsePrReviewContent(serverResponse(c, FINDING)).unparsedFindingCount).toBe(0);
  });

  it('a partial-coverage marker without a decodable manifest is still incomplete', () => {
    const report = build(
      '## Summary\nx\n## Risk Findings\nNo material risks found.\n[[px:review-incomplete reason=partial-coverage]]',
    );
    expect(report.completeness?.complete).toBe(false);
    expect(report.riskLevel).toBe('unknown');
  });

  it('legacy server: a complete answer over truncated scope is never LOW', () => {
    const scope: PRReviewScope = {
      source: 'github_api',
      totalFiles: 61,
      analyzedFiles: 25,
      skippedFiles: 36,
      truncated: true,
    };
    const report = build('## Summary\nfine\n## Risk Findings\nNo material risks found.', scope);
    expect(report.completeness?.complete).toBe(true);
    expect(report.riskLevel).toBe('unknown');
    const full = build('## Summary\nfine\n## Risk Findings\nNo material risks found.', {
      ...scope,
      totalFiles: 25,
      skippedFiles: 0,
      truncated: false,
    });
    expect(full.riskLevel).toBe('low');
  });

  it('exports a coverage section listing what was not reviewed', () => {
    const report = build(serverResponse(coverage(), FINDING));
    const md = formatPrReviewMarkdown(report);
    expect(md).toContain('## Coverage');
    expect(md).toContain('**Partial coverage** — 25 of 61 changed files fully reviewed.');
    expect(md).toContain('- 30 deferred (review budget reached)');
    expect(md).toContain('- 1 of 2 AI batches failed');
    expect(md).toContain('- `apps/api/src/billing/reconcile.ts` (no patch)');
    expect(md).toContain('   Lines: L40-L42');
    expect(buildPrReviewCommentDraft(report)).toContain(
      '> Partial coverage — 25 of 61 files fully reviewed',
    );
  });
});
