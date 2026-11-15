/**
 * Exports must say whether Project Memory was used (memory-on and memory-off reviews are
 * distinguishable), never leak rule text (personal preferences are private; exports leave the
 * workspace), and never claim a rule changed a finding.
 */
import { describe, expect, it } from 'vitest';
import type { PageContext, ProjectMemoryPromptMetadata, PRReviewReport } from '@project-x/types';

import { buildPrReviewReport } from './build-pr-review-report';
import {
  buildPrReviewCommentDraft,
  buildPrReviewHandoffSummary,
  formatPrReviewMarkdown,
} from './format-pr-review-markdown';

const CONTEXT: PageContext = {
  type: 'github',
  url: 'https://github.com/acme/app/pull/7',
  title: 'PR',
  github: { owner: 'acme', repository: 'app', pullRequestNumber: 7 },
};

const report = (): PRReviewReport =>
  buildPrReviewReport({
    markdown: '## Summary\nReviewed.\n\n## Risk Findings\nNo material risks found.',
    context: CONTEXT,
    scope: {
      source: 'github_api',
      totalFiles: 1,
      analyzedFiles: 1,
      skippedFiles: 0,
      truncated: false,
    },
    final: true,
  })!;

const SHARED_TEXT = 'Webhook handlers must be idempotent.';
const PERSONAL_TEXT = 'My private preference: be terse with Alice.';
const applied: ProjectMemoryPromptMetadata = {
  status: 'applied',
  version: 'pmv-2-abc',
  requested: 'on',
  requestSource: 'explicit',
  ruleCount: 2,
  rules: [
    {
      id: 'm1',
      key: 'pay.wh',
      category: 'PROJECT_CONSTRAINT' as never,
      title: SHARED_TEXT,
      confidence: 'high',
      visibility: 'workspace',
    },
    {
      id: 'm2',
      key: 'pref.terse',
      category: 'USER_PREFERENCE' as never,
      title: PERSONAL_TEXT,
      confidence: 'high',
      visibility: 'user',
    },
  ],
};
const disabled: ProjectMemoryPromptMetadata = {
  status: 'disabled',
  requested: 'off',
  requestSource: 'explicit',
  ruleCount: 0,
};
const skipped: ProjectMemoryPromptMetadata = {
  status: 'skipped',
  reason: 'github_not_connected',
  requested: 'on',
  ruleCount: 0,
};

describe('Project Memory in exports', () => {
  it('memory-on and memory-off reviews are distinguishable in the full export and summary', () => {
    const on = formatPrReviewMarkdown(report(), { memory: applied });
    const off = formatPrReviewMarkdown(report(), { memory: disabled });
    expect(on).toContain('## Project Memory');
    expect(on).toContain(
      'Applied — 2 rules were sent to the AI as review context (1 shared rule, 1 personal preference).',
    );
    expect(on).toMatch(/does not show whether any rule changed a finding/);
    expect(off).toContain('Off for this review — no saved rules were retrieved or sent to the AI.');
    expect(on).not.toBe(off);
    expect(buildPrReviewHandoffSummary(report(), {}, applied)).toContain(
      'Project Memory: applied (2 rules)',
    );
    expect(buildPrReviewHandoffSummary(report(), {}, disabled)).toContain('Project Memory: off');
  });

  it('skipped memory states the reason', () => {
    expect(formatPrReviewMarkdown(report(), { memory: skipped })).toMatch(
      /Not applied — Connect GitHub in dashboard Settings to use project memory\./,
    );
  });

  it('no export ever contains rule text (shared or personal)', () => {
    const outputs = [
      formatPrReviewMarkdown(report(), { memory: applied }),
      buildPrReviewHandoffSummary(report(), {}, applied),
      buildPrReviewCommentDraft(report()),
    ];
    for (const text of outputs) {
      expect(text).not.toContain(SHARED_TEXT);
      expect(text).not.toContain(PERSONAL_TEXT);
    }
    // The public PR comment draft carries no memory information at all.
    expect(buildPrReviewCommentDraft(report())).not.toMatch(/Project Memory/i);
  });

  it('unknown memory state (older server) adds nothing', () => {
    expect(formatPrReviewMarkdown(report())).not.toContain('## Project Memory');
    expect(formatPrReviewMarkdown(report(), { memory: null })).not.toContain('## Project Memory');
  });
});
