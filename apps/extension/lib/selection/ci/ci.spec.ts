import { describe, expect, it } from 'vitest';

import { formatCiEntryLabel, safeHttpsHref } from './index';

describe('ci helpers', () => {
  it('formats entry labels', () => {
    expect(
      formatCiEntryLabel({
        owner: 'a',
        repository: 'b',
        pullRequestNumber: 1,
        headSha: 'abc',
        overallStatus: 'FAILURE',
        counts: {
          total: 3,
          passed: 1,
          failed: 2,
          pending: 0,
          cancelled: 0,
          neutral: 0,
          skipped: 0,
        },
        checks: [],
        fetchedAt: new Date().toISOString(),
      }),
    ).toBe('CI · 2 failed');

    expect(
      formatCiEntryLabel({
        owner: 'a',
        repository: 'b',
        pullRequestNumber: 1,
        headSha: 'abc',
        overallStatus: 'PENDING',
        counts: {
          total: 2,
          passed: 0,
          failed: 0,
          pending: 2,
          cancelled: 0,
          neutral: 0,
          skipped: 0,
        },
        checks: [],
        fetchedAt: new Date().toISOString(),
      }),
    ).toBe('CI · Running');
  });

  it('rejects unsafe external URLs', () => {
    expect(safeHttpsHref('javascript:alert(1)')).toBeNull();
    expect(safeHttpsHref('http://evil.test')).toBeNull();
    expect(safeHttpsHref('https://github.com/a/b/actions')).toContain('https://');
  });
});
