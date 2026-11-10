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
    // A finished review of one file diff — the only state where overall risk is derived.
    const report = buildPrReviewReport({
      markdown: SAMPLE,
      final: true,
      context: {
        type: 'github',
        url: 'https://github.com/acme/app/pull/3',
        title: 't',
        github: {
          owner: 'acme',
          repository: 'app',
          pullRequestNumber: 3,
          changedFiles: [{ path: 'src/a.ts', patchExcerpt: '+a.b' }],
        },
      },
    })!;

    const summary = buildPrReviewHandoffSummary(report);
    expect(summary).toContain('Overall risk: MEDIUM');
    expect(summary).toContain('1 open');
  });

  it('never exports LOW risk or "0 findings" for an incomplete review', () => {
    const report = buildPrReviewReport({
      markdown: '## Summary\nChanged files list is empty.\n## Risk Findings\nCannot assess.',
      final: true,
      context: {
        type: 'github',
        url: 'https://github.com/acme/app/pull/3',
        title: 't',
        github: { owner: 'acme', repository: 'app', pullRequestNumber: 3 },
      },
    })!;

    const outputs = [
      buildPrReviewHandoffSummary(report),
      formatPrReviewMarkdown(report),
      buildPrReviewCommentDraft(report),
    ];
    for (const text of outputs) {
      expect(text).not.toMatch(/\bLOW\b/);
      expect(text).not.toMatch(/\b0 findings?\b|Findings: 0\b/);
      expect(text).toMatch(/INCOMPLETE|Incomplete/);
    }
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
