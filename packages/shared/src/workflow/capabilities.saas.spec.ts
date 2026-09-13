import { describe, expect, it } from 'vitest';

import { CAPABILITY_CATALOG } from './capabilities';

describe('WorkflowCapabilityCatalog — Day 25 billing isolation', () => {
  it('does not register billing or workspace-admin capabilities for the planner', () => {
    const ids = Object.keys(CAPABILITY_CATALOG);
    const forbidden = [
      'billing',
      'checkout',
      'subscription',
      'invite',
      'workspace',
      'paddle',
      'upgrade',
      'cancel',
      'member',
      'role',
      'ownership',
    ];
    for (const id of ids) {
      const lower = id.toLowerCase();
      for (const token of forbidden) {
        expect(lower).not.toContain(token);
      }
    }

    const descriptions = Object.values(CAPABILITY_CATALOG)
      .map((c) => `${c.title} ${c.description}`.toLowerCase())
      .join('\n');
    expect(descriptions).not.toMatch(/upgrade (plan|subscription)/i);
    expect(descriptions).not.toMatch(/invite (user|member)/i);
    expect(descriptions).not.toMatch(/cancel subscription/i);
  });
});
