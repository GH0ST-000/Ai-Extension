import { describe, expect, it } from 'vitest';
import type { ProjectMemoryItem } from '@project-x/types';

import { buildProjectConstraintContext } from './constraints';

function item(
  partial: Partial<ProjectMemoryItem> & Pick<ProjectMemoryItem, 'id' | 'key' | 'value'>,
): ProjectMemoryItem {
  return {
    id: partial.id,
    project: { provider: 'github', owner: 'acme', repository: 'app' },
    category: partial.category ?? 'PROJECT_CONSTRAINT',
    key: partial.key,
    value: partial.value,
    confidence: 'high',
    status: partial.status ?? 'active',
    provenance: partial.provenance ?? [
      {
        type: 'user_explicit',
        observedAt: '2026-09-12T00:00:00.000Z',
        summary: 'user rule',
      },
    ],
    scope: { type: 'repository' },
    createdAt: '2026-09-12T00:00:00.000Z',
    updatedAt: '2026-09-12T00:00:00.000Z',
  };
}

describe('buildProjectConstraintContext', () => {
  it('detects no_new_dependencies from rule text', () => {
    const ctx = buildProjectConstraintContext([
      item({
        id: '1',
        key: 'constraint.deps',
        value: { summary: 'Do not introduce new dependencies without asking.' },
      }),
    ]);
    expect(ctx.noNewDependencies).toBe(true);
    expect(ctx.rules).toHaveLength(1);
  });

  it('detects no_new_dependencies from key', () => {
    const ctx = buildProjectConstraintContext([
      item({
        id: '1',
        key: 'constraint.no_new_dependencies',
        value: { summary: 'Ask before adding packages.' },
      }),
    ]);
    expect(ctx.noNewDependencies).toBe(true);
  });

  it('ignores inactive items', () => {
    const ctx = buildProjectConstraintContext([
      item({
        id: '1',
        key: 'constraint.no_new_dependencies',
        value: { summary: 'No new deps' },
        status: 'archived',
      }),
    ]);
    expect(ctx.noNewDependencies).toBeUndefined();
    expect(ctx.rules).toEqual([]);
  });
});
