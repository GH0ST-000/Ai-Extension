import { describe, expect, it } from 'vitest';

import {
  knownInSelectedScope,
  noOrgWideClaim,
  notEvidentInScope,
  systemFlowIncomplete,
} from './scope-language';

describe('scope-language', () => {
  it('uses non-overclaiming wording', () => {
    expect(knownInSelectedScope('consumers')).toContain('selected repositories');
    expect(noOrgWideClaim()).toContain('not organization-wide');
    expect(notEvidentInScope('Impact')).toContain('not evident');
    expect(systemFlowIncomplete()).toContain('not evident in the selected repositories');
  });
});
