import { describe, expect, it } from 'vitest';

import { createReviewDraftFromReport } from '../review-draft/draft-builders';
import { buildPrReviewReport } from './build-pr-review-report';
import { parsePrReviewContent } from './parse-pr-review';

const IMPACT = `## Downstream Impact
Breaking API change detected in gh0st-000/project-x-test-api.

- **GET /api/users** — Response field removed: \`users[].name\`
  - Potentially affected: gh0st-000/project-x-test-client — confidence High — evidence: src/userApiClient.ts — last validated 2026-11-19

_Potential downstream impact, not a confirmed runtime failure: consumer usage of the changed fields was not verified._`;
const REVIEW = `## Summary
Reviewed 2 files.

## Risk Findings
1. **[HIGH]** \`src/a.ts:3\` — Null dereference
   Why: x may be null.`;

describe('PR Review "## Downstream Impact" section', () => {
  it('is extracted without affecting summary or findings (section placed first by the server)', () => {
    const parsed = parsePrReviewContent(`${IMPACT}\n\n${REVIEW}`);
    expect(parsed.downstreamImpact).toContain(
      'Potentially affected: gh0st-000/project-x-test-client',
    );
    expect(parsed.summary).toBe('Reviewed 2 files.');
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.unparsedFindingCount).toBe(0);
  });

  it('never leaks into findings even if it appears after them', () => {
    const parsed = parsePrReviewContent(`${REVIEW}\n\n${IMPACT}`);
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.unparsedFindingCount).toBe(0);
    expect(parsed.downstreamImpact).toContain('Breaking API change');
  });

  it('reviews without the section are unchanged', () => {
    expect(parsePrReviewContent(REVIEW).downstreamImpact).toBe('');
  });

  it('is shown in the report but never copied into a GitHub review draft', () => {
    const report = buildPrReviewReport({
      markdown: `${IMPACT}\n\n${REVIEW}`,
      final: true,
    } as never)!;
    expect(report.downstreamImpact).toContain('project-x-test-client');
    const draft = createReviewDraftFromReport(
      report as never,
      { owner: 'gh0st-000', repository: 'project-x-test-api', pullRequestNumber: 7 } as never,
    );
    expect(JSON.stringify(draft)).not.toContain('project-x-test-client');
  });
});

describe('exports', () => {
  it('Copy Full Review / Export Markdown includes the section; the PR comment draft never does', async () => {
    const { formatPrReviewMarkdown, buildPrReviewCommentDraft } =
      await import('./format-pr-review-markdown');
    const report = buildPrReviewReport({
      markdown: `${IMPACT}\n\n${REVIEW}`,
      final: true,
    } as never)!;
    const exported = formatPrReviewMarkdown(report);
    expect(exported).toContain('## Downstream Impact');
    expect(exported).toContain('Potentially affected: gh0st-000/project-x-test-client');
    expect(exported.indexOf('## Downstream Impact')).toBeLessThan(
      exported.indexOf('## Risk Findings'),
    );
    expect(buildPrReviewCommentDraft(report)).not.toContain('project-x-test-client');
    expect(
      formatPrReviewMarkdown(buildPrReviewReport({ markdown: REVIEW, final: true } as never)!),
    ).not.toContain('Downstream Impact');
  });
});
