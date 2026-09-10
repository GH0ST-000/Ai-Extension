import { describe, expect, it } from 'vitest';

import { canOfferApplyFix } from './apply-fix-panel';

describe('canOfferApplyFix', () => {
  it('requires trusted PR identity, path, and fix code', () => {
    expect(
      canOfferApplyFix({
        fixCode: 'const x = 1',
        target: {
          owner: 'acme',
          repository: 'app',
          pullRequestNumber: 12,
          path: 'src/a.ts',
        },
      }),
    ).toBe(true);

    expect(
      canOfferApplyFix({
        fixCode: 'const x = 1',
        target: {
          owner: 'unknown',
          repository: 'app',
          pullRequestNumber: 12,
          path: 'src/a.ts',
        },
      }),
    ).toBe(false);

    expect(canOfferApplyFix({ fixCode: null, target: null })).toBe(false);
  });
});
