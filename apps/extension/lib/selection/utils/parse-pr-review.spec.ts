import { describe, expect, it } from 'vitest';

import { parsePrReviewContent } from './parse-pr-review';

describe('parsePrReviewContent', () => {
  it('parses summary and numbered risk findings', () => {
    const content = [
      '## Summary',
      'Overall risk is medium due to auth edge cases.',
      '',
      '## Risk Findings',
      '1. **[high]** `src/auth.ts` — Missing null check',
      '   Why: token can be undefined before use.',
      '2. **[low]** `src/util.ts` — Verbose logging',
      '   Why: noisy in production.',
    ].join('\n');

    const parsed = parsePrReviewContent(content);
    expect(parsed.structured).toBe(true);
    expect(parsed.summary).toContain('Overall risk is medium');
    expect(parsed.findings).toHaveLength(2);
    expect(parsed.findings[0]).toMatchObject({
      severity: 'high',
      filePath: 'src/auth.ts',
      title: 'Missing null check',
    });
    expect(parsed.findings[0]?.why).toContain('token can be undefined');
  });

  it('returns unstructured prose when sections are missing', () => {
    const parsed = parsePrReviewContent('Looks fine overall.');
    expect(parsed.structured).toBe(false);
    expect(parsed.findings).toHaveLength(0);
    expect(parsed.summary).toContain('Looks fine');
  });
});
