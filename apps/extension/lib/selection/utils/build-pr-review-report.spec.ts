import { describe, expect, it } from 'vitest';
import type { PageContext } from '@project-x/types';

import { buildPrReviewReport, filterPrFindings, prFindingId } from './build-pr-review-report';

const SAMPLE = [
  '## Summary',
  'Auth middleware looks solid; naming is inconsistent.',
  '',
  '## Risk Findings',
  '1. **[high]** `routes/api.php` — Singular employee resource',
  '   Why: Breaks REST conventions.',
  '2. **[low]** `routes/api.php` — Missing rate limit note',
  '   Why: Docs only.',
].join('\n');

const CONTEXT: PageContext = {
  type: 'github',
  url: 'https://github.com/acme/app/pull/12/files',
  title: 'PR',
  github: {
    owner: 'acme',
    repository: 'app',
    pullRequestNumber: 12,
    pullRequestTitle: 'Fix routes',
    changedFiles: [{ path: 'routes/api.php', patchExcerpt: '+x' }],
    changedFilesTruncated: true,
    filesTab: true,
  },
};

describe('buildPrReviewReport', () => {
  it('builds report stats and risk from markdown + context', () => {
    const report = buildPrReviewReport({ markdown: SAMPLE, context: CONTEXT });
    expect(report).not.toBeNull();
    expect(report!.repository).toEqual({ owner: 'acme', name: 'app' });
    expect(report!.pullRequest.number).toBe(12);
    expect(report!.riskLevel).toBe('high');
    expect(report!.stats.findings).toBe(2);
    expect(report!.stats.high).toBe(1);
    expect(report!.stats.low).toBe(1);
    expect(report!.stats.analyzedFiles).toBe(1);
    expect(report!.reviewScope?.truncated).toBe(true);
    expect(report!.findings[0]?.id).toBe(
      prFindingId({
        index: 1,
        filePath: 'routes/api.php',
        title: 'Singular employee resource',
      }),
    );
  });

  it('filters open findings', () => {
    const report = buildPrReviewReport({ markdown: SAMPLE, context: CONTEXT })!;
    const resolved = new Set([report.findings[0]!.id]);
    const open = filterPrFindings(report.findings, 'open', resolved);
    expect(open).toHaveLength(1);
    expect(open[0]?.severity).toBe('low');
  });
});
