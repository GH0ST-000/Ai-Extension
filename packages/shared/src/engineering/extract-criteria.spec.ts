import { describe, expect, it } from 'vitest';

import { extractAcceptanceCriteriaFromPlainText } from './extract-criteria';

describe('extractAcceptanceCriteriaFromPlainText', () => {
  it('extracts bullet and numbered criteria', () => {
    const text = `
Some intro.

- Must return 409 on duplicate retry
* Must release lock on failure
1. Request includes optional reason
2) Idempotent charge behavior
`;
    const criteria = extractAcceptanceCriteriaFromPlainText(text);
    expect(criteria.map((c) => c.id)).toEqual(['ac-1', 'ac-2', 'ac-3', 'ac-4']);
    expect(criteria.every((c) => c.source === 'description')).toBe(true);
    expect(criteria[0]?.text).toContain('409');
  });

  it('prefers Acceptance Criteria section when present', () => {
    const text = `
Summary of work

- Unrelated bullet in summary

Acceptance Criteria:
- Duplicate retries must not create multiple charges
- Retry lock must expire after failure

Notes:
- Do not treat this as a criterion
`;
    const criteria = extractAcceptanceCriteriaFromPlainText(text);
    expect(criteria).toHaveLength(2);
    expect(criteria[0]?.text).toMatch(/Duplicate retries/i);
    expect(criteria[1]?.text).toMatch(/Retry lock/i);
  });

  it('caps at max criteria', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `- Criterion number ${i + 1}`).join('\n');
    const criteria = extractAcceptanceCriteriaFromPlainText(lines, 5);
    expect(criteria).toHaveLength(5);
    expect(criteria[4]?.id).toBe('ac-5');
  });

  it('dedupes identical text', () => {
    const text = `
- Same criterion text
- Same criterion text
`;
    expect(extractAcceptanceCriteriaFromPlainText(text)).toHaveLength(1);
  });

  it('returns empty for blank input', () => {
    expect(extractAcceptanceCriteriaFromPlainText('')).toEqual([]);
    expect(extractAcceptanceCriteriaFromPlainText('   ')).toEqual([]);
  });
});
