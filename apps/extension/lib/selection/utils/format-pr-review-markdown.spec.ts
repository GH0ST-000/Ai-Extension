import { describe, expect, it } from 'vitest';

import { buildPrReviewReport } from './build-pr-review-report';
import {
  buildPrReviewCommentDraft,
  buildPrReviewHandoffSummary,
  formatPrReviewMarkdown,
} from './format-pr-review-markdown';

const SAMPLE = [
  '## Summary',
  'Overall medium risk.',
  '',
  '## Risk Findings',
  '1. **[medium]** `src/a.ts` — Nullable access',
  '   Why: Missing guard.',
].join('\n');

describe('formatPrReviewMarkdown', () => {
  it('exports a complete markdown artifact', () => {
    const report = buildPrReviewReport({
      markdown: SAMPLE,
      context: {
        type: 'github',
        url: 'https://github.com/acme/app/pull/3',
        title: 't',
        github: {
          owner: 'acme',
          repository: 'app',
          pullRequestNumber: 3,
          pullRequestTitle: 'Guards',
          changedFiles: [{ path: 'src/a.ts' }],
        },
      },
    })!;

    const md = formatPrReviewMarkdown(report, {
      dispositions: { [report.findings[0]!.id]: 'reviewed' },
    });

    expect(md).toContain('# Review Report — acme/app');
    expect(md).toContain('## Handoff summary');
    expect(md).toContain('## Overview');
    expect(md).toContain('Overall medium risk.');
    expect(md).toContain('(reviewed)');
    expect(md).toContain('read-only review handoff');
  });

  it('builds a compact handoff summary', () => {
    const report = buildPrReviewReport({
      markdown: SAMPLE,
      context: {
        type: 'github',
        url: 'https://github.com/acme/app/pull/3',
        title: 't',
        github: {
          owner: 'acme',
          repository: 'app',
          pullRequestNumber: 3,
          changedFiles: [],
        },
      },
    })!;

    const summary = buildPrReviewHandoffSummary(report);
    expect(summary).toContain('Overall risk: MEDIUM');
    expect(summary).toContain('1 open');
  });

  it('builds a PR comment draft for manual paste', () => {
    const report = buildPrReviewReport({
      markdown: SAMPLE,
      context: {
        type: 'github',
        url: 'https://github.com/acme/app/pull/3',
        title: 't',
        github: {
          owner: 'acme',
          repository: 'app',
          pullRequestNumber: 3,
          pullRequestTitle: 'Guards',
          changedFiles: [{ path: 'src/a.ts' }],
        },
      },
    })!;

    const draft = buildPrReviewCommentDraft(report);
    expect(draft).toContain('### Project X review — acme/app #3');
    expect(draft).toContain('**Open findings**');
    expect(draft).toContain('Nullable access');
    expect(draft).toContain('Post to GitHub');
  });
});
