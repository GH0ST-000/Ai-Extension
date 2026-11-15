/**
 * PR review coverage when the GitHub API was unavailable and files came from the page.
 * The PR's total file count is unknown, so the report must never claim full coverage or LOW
 * risk — consistently in the report model, the UI, Markdown exports and the coverage metadata.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  PageContext,
  PRReviewCoverage,
  PRReviewReport,
  PRReviewScope,
} from '@project-x/types';

import { PrReviewReportView } from '../components/pr-review-report-view';
import { buildPrReviewReport, formatReviewedFilesLabel } from './build-pr-review-report';
import {
  buildPrReviewCommentDraft,
  buildPrReviewHandoffSummary,
  formatPrReviewMarkdown,
} from './format-pr-review-markdown';
import { isUnverifiedPageScope, PAGE_FALLBACK_NOTICE } from './pr-review-coverage';

const CONTEXT: PageContext = {
  type: 'github',
  url: 'https://github.com/acme/app/pull/7',
  title: 'PR',
  github: { owner: 'acme', repository: 'app', pullRequestNumber: 7 },
};

const NO_RISKS = 'No material risks found in the reviewed files.';
const HIGH_FINDING = [
  '1. **[high]** `src/a.ts` — Missing authorization check',
  '   Why: Any user can delete any note.',
  '   Lines: L4',
  '   Ref: prf_0123456789abcdef',
  '   Evidence:',
  '   │ await db.note.delete({ where: { id } });',
].join('\n');

function coverage(over: Partial<PRReviewCoverage> = {}): PRReviewCoverage {
  return {
    version: 1,
    source: 'page',
    totalFiles: null,
    complete: false,
    counts: {
      reviewed_full: 0,
      reviewed_partial: 3,
      excluded_generated: 0,
      excluded_binary: 0,
      excluded_no_changes: 0,
      deferred_budget: 0,
      no_patch: 0,
      not_fetched: 0,
      review_failed: 0,
    },
    files: ['src/a.ts', 'src/b.ts', 'src/c.ts'].map((path) => ({
      path,
      status: 'reviewed_partial' as const,
      priority: 50,
      patchChars: 100,
      reviewedChars: 100,
    })),
    batches: [{ id: 'b1', status: 'succeeded', attempts: 1, files: 3 }],
    findings: { accepted: 0, duplicates: 0, rejected: 0, rejectedByReason: {}, linesCorrected: 0 },
    riskLevel: 'unknown',
    usageUnits: 1,
    ...over,
  };
}

const encode = (c: unknown) => Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');

function batchedResponse(c: PRReviewCoverage, findings = NO_RISKS): string {
  return [
    '## Summary',
    "Coverage: unverified — the GitHub API was unavailable, so files were collected from the GitHub page and the PR's total number of changed files is unknown; 0 of 3 files found on the page fully reviewed; 3 partially.",
    '',
    '## Risk Findings',
    findings,
    '',
    `[[px:review-coverage ${encode(c)}]]`,
    ...(c.complete ? [] : ['[[px:review-incomplete reason=partial-coverage]]']),
  ].join('\n');
}

/** Legacy / scope-header-only review (no coverage manifest). */
function scopeOnly(scope: PRReviewScope, findings = NO_RISKS): PRReviewReport {
  return buildPrReviewReport({
    markdown: ['## Summary', 'Reviewed.', '', '## Risk Findings', findings].join('\n'),
    context: CONTEXT,
    scope,
    final: true,
  })!;
}

const PAGE_SCOPE: PRReviewScope = {
  source: 'page',
  totalFiles: null,
  analyzedFiles: 3,
  skippedFiles: 0,
  truncated: false, // the page did not notice anything missing
};

afterEach(cleanup);

describe('page fallback with an unknown total', () => {
  it('batched review: partial coverage, risk not LOW, page wording', () => {
    const report = buildPrReviewReport({
      markdown: batchedResponse(coverage()),
      context: CONTEXT,
      final: true,
    })!;
    expect(report.riskLevel).toBe('unknown');
    expect(report.reviewScope).toMatchObject({ source: 'page', totalFiles: null, truncated: true });
    expect(report.coverage).toMatchObject({ source: 'page', totalFiles: null, complete: false });
    expect(formatReviewedFilesLabel(report)).toBe(
      '3 files reviewed from the GitHub page (total unknown)',
    );
  });

  it('defense in depth: a server manifest claiming complete / LOW for page data is not trusted', () => {
    const lying = coverage({
      complete: true,
      riskLevel: 'low',
      counts: { ...coverage().counts, reviewed_full: 3, reviewed_partial: 0 },
    });
    const report = buildPrReviewReport({
      markdown: batchedResponse(lying),
      context: CONTEXT,
      final: true,
    })!;
    expect(report.riskLevel).toBe('unknown');
    expect(report.reviewScope?.truncated).toBe(true);
    const md = formatPrReviewMarkdown(report);
    expect(md).not.toContain('Full coverage');
    expect(md).toContain(
      '**Partial coverage** — 3 of 3 files found on the GitHub page fully reviewed',
    );
  });

  it('scope-only review with partial page data the page did not flag: not LOW, not full', () => {
    const report = scopeOnly(PAGE_SCOPE);
    expect(report.completeness?.complete).toBe(true);
    expect(report.riskLevel).toBe('unknown'); // previously LOW
    expect(report.reviewScope?.truncated).toBe(true);
    expect(formatReviewedFilesLabel(report)).toBe(
      '3 files reviewed from the GitHub page (total unknown)',
    );
  });

  it('a HIGH finding is still reported as HIGH', () => {
    expect(scopeOnly(PAGE_SCOPE, HIGH_FINDING).riskLevel).toBe('high');
  });

  it('a page scope with a known total is not treated as unverified', () => {
    expect(isUnverifiedPageScope({ source: 'page', totalFiles: 3 })).toBe(false);
    expect(isUnverifiedPageScope({ source: 'page', totalFiles: null })).toBe(true);
    expect(isUnverifiedPageScope({ source: 'github_api', totalFiles: null })).toBe(false);
    expect(isUnverifiedPageScope(undefined)).toBe(false);
  });
});

describe('GitHub API retrieval is unchanged', () => {
  it('complete API coverage with no findings stays LOW with "N of M" wording', () => {
    const report = scopeOnly({
      source: 'github_api',
      totalFiles: 3,
      analyzedFiles: 3,
      skippedFiles: 0,
      truncated: false,
    });
    expect(report.riskLevel).toBe('low');
    expect(report.reviewScope?.truncated).toBe(false);
    expect(formatReviewedFilesLabel(report)).toBe('3 files reviewed');
    const md = formatPrReviewMarkdown(report);
    expect(md).not.toContain(PAGE_FALLBACK_NOTICE);
    expect(md).not.toContain('Unverified coverage');
  });

  it('a complete API manifest keeps the server risk and full-coverage wording', () => {
    const api = coverage({
      source: 'github_api',
      totalFiles: 3,
      complete: true,
      riskLevel: 'low',
      counts: { ...coverage().counts, reviewed_full: 3, reviewed_partial: 0 },
    });
    const report = buildPrReviewReport({
      markdown: batchedResponse(api),
      context: CONTEXT,
      final: true,
    })!;
    expect(report.riskLevel).toBe('low');
    expect(formatPrReviewMarkdown(report)).toContain(
      'Full coverage: all 3 reviewable files of 3 changed files were reviewed.',
    );
  });
});

describe('UI, Markdown and metadata stay consistent', () => {
  const reports = () => [
    buildPrReviewReport({ markdown: batchedResponse(coverage()), context: CONTEXT, final: true })!,
    scopeOnly(PAGE_SCOPE),
  ];

  it('every export explains the page fallback and never claims full coverage', () => {
    for (const report of reports()) {
      const md = formatPrReviewMarkdown(report);
      expect(md).toContain('## Coverage');
      expect(md).toContain(`**Unverified coverage** — ${PAGE_FALLBACK_NOTICE}`);
      expect(md).not.toContain('Full coverage');
      expect(md).not.toMatch(/Risk level: \*\*LOW\*\*/);
      expect(md).toContain('reviewed from the GitHub page (total unknown)');
      expect(md).toContain('- Scope: partial');

      const handoff = buildPrReviewHandoffSummary(report);
      expect(handoff).toContain('(total unknown) (partial coverage)');
      expect(handoff).not.toContain('Overall risk: LOW');

      const comment = buildPrReviewCommentDraft(report);
      expect(comment).toContain(PAGE_FALLBACK_NOTICE);
      expect(comment).not.toContain('**Risk:** LOW');
    }
  });

  it('the report view shows the notice, partial coverage and the page label', () => {
    for (const report of reports()) {
      render(
        <PrReviewReportView
          report={report}
          filter="all"
          dispositions={{}}
          onFilterChange={() => undefined}
          onSetDisposition={() => undefined}
        />,
      );
      const notice = screen.getByTestId('pr-review-page-fallback-notice');
      expect(notice.textContent).toContain(PAGE_FALLBACK_NOTICE);
      expect(screen.getByText('partial coverage')).toBeTruthy();
      expect(screen.queryByText('full coverage')).toBeNull();
      expect(
        screen.getByText('3 files reviewed from the GitHub page (total unknown)'),
      ).toBeTruthy();
      cleanup();
    }
  });

  it('an API review shows no page notice', () => {
    const report = scopeOnly({
      source: 'github_api',
      totalFiles: 3,
      analyzedFiles: 3,
      skippedFiles: 0,
      truncated: false,
    });
    render(
      <PrReviewReportView
        report={report}
        filter="all"
        dispositions={{}}
        onFilterChange={() => undefined}
        onSetDisposition={() => undefined}
      />,
    );
    expect(screen.queryByTestId('pr-review-page-fallback-notice')).toBeNull();
  });
});
