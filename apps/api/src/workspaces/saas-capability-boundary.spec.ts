import { CAPABILITY_CATALOG, getPlannerCapabilitySummaries } from '@project-x/shared';
import { describe, expect, it } from 'vitest';

/**
 * Prompt-injection / capability boundary: billing and workspace admin must never be
 * exposed as workflow planner/executor capabilities.
 */
describe('workflow capability registry SaaS boundary', () => {
  it('does not include billing or workspace-admin capabilities', () => {
    const keys = Object.keys(CAPABILITY_CATALOG);
    const joined = keys.join(' ').toLowerCase();
    const forbiddenFragments = [
      'billing',
      'checkout',
      'subscription',
      'paddle',
      'workspace',
      'invite',
      'member',
      'ownership',
      'entitlement',
      'usage_limit',
    ];

    for (const fragment of forbiddenFragments) {
      expect(joined.includes(fragment)).toBe(false);
    }

    const summaries = getPlannerCapabilitySummaries();
    const summaryBlob = JSON.stringify(summaries).toLowerCase();
    for (const fragment of ['billing:manage', 'members:invite', 'workspace:delete']) {
      expect(summaryBlob.includes(fragment)).toBe(false);
    }
  });
});
