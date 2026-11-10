import { describe, expect, it } from 'vitest';
import type { PageContext, PRReviewScope } from '@project-x/types';

import { parseProjectMemoryHeader } from '../../services/ai-client';
import { buildPrReviewReport, formatFindingsCountLabel } from './build-pr-review-report';
import {
  memoryCategoryLabel,
  memoryChipLabel,
  memorySkipReasonText,
} from './project-memory-metadata';

function encode(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const RULE = {
  id: 'mem-1',
  key: 'rule.isolation',
  category: 'SECURITY_CONVENTION',
  title: 'Verify workspace isolation — სამუშაო სივრცე',
  confidence: 'high',
  visibility: 'user',
};

describe('parseProjectMemoryHeader', () => {
  it('decodes applied rules, including non-ASCII titles', () => {
    expect(
      parseProjectMemoryHeader(encode({ status: 'applied', version: 'v1', rules: [RULE] })),
    ).toEqual({ status: 'applied', version: 'v1', rules: [RULE] });
  });

  it('decodes a known skip reason', () => {
    expect(
      parseProjectMemoryHeader(encode({ status: 'skipped', reason: 'no_relevant_rules' })),
    ).toEqual({ status: 'skipped', reason: 'no_relevant_rules' });
  });

  it('drops malformed headers, unknown reasons and invalid rules', () => {
    expect(parseProjectMemoryHeader(null)).toBeNull();
    expect(parseProjectMemoryHeader('%%%')).toBeNull();
    expect(parseProjectMemoryHeader(encode({ status: 'skipped', reason: 'boom' }))).toBeNull();
    expect(parseProjectMemoryHeader(encode({ status: 'applied', rules: [] }))).toBeNull();
    const parsed = parseProjectMemoryHeader(
      encode({
        status: 'applied',
        version: 'v1',
        rules: [RULE, { ...RULE, id: 'x', confidence: 'certain' }, { title: 'no id' }],
      }),
    );
    expect(parsed?.status === 'applied' && parsed.rules.map((r) => r.id)).toEqual(['mem-1']);
  });
});

describe('memory labels', () => {
  it('summarises applied and skipped memory', () => {
    expect(memoryChipLabel(null)).toBeNull();
    expect(memoryChipLabel({ status: 'applied', version: 'v', rules: [RULE as never] })).toBe(
      '1 memory rule',
    );
    expect(memoryChipLabel({ status: 'skipped', reason: 'no_active_rules' })).toBe(
      'No memory applied',
    );
    expect(memorySkipReasonText('github_not_connected')).toMatch(/Connect GitHub/);
    expect(memoryCategoryLabel('SECURITY_CONVENTION')).toBe('Security convention');
  });
});

describe('risk level for complete, truncated and failed reviews', () => {
  const context: PageContext = {
    type: 'github',
    url: 'https://github.com/acme/app/pull/1',
    title: 'PR',
    github: { owner: 'acme', repository: 'app', pullRequestNumber: 1 },
  };
  const scope: PRReviewScope = {
    source: 'github_api',
    totalFiles: 4,
    analyzedFiles: 4,
    skippedFiles: 0,
    truncated: false,
  };
  const build = (markdown: string, final = true) =>
    buildPrReviewReport({ markdown, context, scope, final })!;

  const MEDIUM = '## Summary\ns\n## Risk Findings\n1. **[medium]** `a.ts` — Weak check\n   Why: w';

  it('complete review: risk derived from findings', () => {
    expect(build(MEDIUM).riskLevel).toBe('medium');
    const clean = build('## Summary\ns\n## Risk Findings\nNo material risks found.');
    expect(clean.riskLevel).toBe('low');
    expect(formatFindingsCountLabel(clean)).toBe('0 findings');
  });

  it('truncated review (token limit): never LOW or MEDIUM, never "0 findings"', () => {
    const cut = build('## Summary\nThis PR changes\n\n[[px:review-incomplete reason=length]]');
    expect(cut.completeness?.complete).toBe(false);
    expect(cut.riskLevel).toBe('unknown');
    expect(formatFindingsCountLabel(cut)).toBe('findings unknown');

    const partial = build(`${MEDIUM}\n\n[[px:review-incomplete reason=length]]`);
    expect(partial.riskLevel).toBe('unknown');
    expect(formatFindingsCountLabel(partial)).toBe('1+ finding (partial)');
  });

  it('truncated review keeps HIGH as a lower bound', () => {
    const high = build(
      '## Summary\ns\n## Risk Findings\n1. **[high]** `a.ts` — Leak\n\n[[px:review-incomplete reason=length]]',
    );
    expect(high.riskLevel).toBe('high');
    expect(high.completeness?.complete).toBe(false);
  });

  it('failed review (provider error mid-stream) is incomplete with unknown risk', () => {
    const failed = build('## Summary\nPartial\n\n[[px:review-incomplete reason=error]]');
    expect(failed.riskLevel).toBe('unknown');
    expect(failed.completeness?.reasons[0]).toMatch(/error/);
  });

  it('while streaming, risk is unknown until a HIGH finding appears', () => {
    expect(build('## Summary\npartial', false).riskLevel).toBe('unknown');
    expect(build(MEDIUM, false).riskLevel).toBe('unknown');
  });
});
