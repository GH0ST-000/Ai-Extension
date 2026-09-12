import { describe, expect, it } from 'vitest';

import {
  compareHttpRequiredFieldsAdded,
  compareTopicRename,
  mergeCompatibilityResults,
} from './compatibility';

describe('compatibility', () => {
  it('flags newly required HTTP fields as potentially breaking', () => {
    const result = compareHttpRequiredFieldsAdded(['id'], ['id', 'attemptReason']);
    expect(result.status).toBe('potentially_breaking');
    expect(result.reasons.some((r) => r.field === 'attemptReason')).toBe(true);
  });

  it('treats unchanged required fields as compatible', () => {
    const result = compareHttpRequiredFieldsAdded(['id'], ['id']);
    expect(result.status).toBe('compatible');
  });

  it('treats topic rename as breaking evidence', () => {
    const result = compareTopicRename('payment.retry.requested', 'payment.retry.v2');
    expect(result.status).toBe('breaking_evidence');
  });

  it('merges results with the highest severity', () => {
    const merged = mergeCompatibilityResults([
      compareHttpRequiredFieldsAdded(['a'], ['a']),
      compareTopicRename('old', 'new'),
    ]);
    expect(merged.status).toBe('breaking_evidence');
  });
});
