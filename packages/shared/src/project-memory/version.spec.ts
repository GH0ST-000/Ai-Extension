import { describe, expect, it } from 'vitest';

import { computeMemoryVersion } from './version';

describe('computeMemoryVersion', () => {
  it('is stable regardless of input order', () => {
    const a = computeMemoryVersion([
      { id: '1', key: 'a', updatedAt: '2026-09-12T00:00:00.000Z', status: 'active' },
      { id: '2', key: 'b', updatedAt: '2026-09-12T01:00:00.000Z', status: 'active' },
    ]);
    const b = computeMemoryVersion([
      { id: '2', key: 'b', updatedAt: '2026-09-12T01:00:00.000Z', status: 'active' },
      { id: '1', key: 'a', updatedAt: '2026-09-12T00:00:00.000Z', status: 'active' },
    ]);
    expect(a).toBe(b);
    expect(a.startsWith('pmv-2-')).toBe(true);
  });

  it('changes when active items change', () => {
    const before = computeMemoryVersion([
      { id: '1', key: 'a', updatedAt: '2026-09-12T00:00:00.000Z', status: 'active' },
    ]);
    const after = computeMemoryVersion([
      { id: '1', key: 'a', updatedAt: '2026-09-12T02:00:00.000Z', status: 'active' },
    ]);
    expect(before).not.toBe(after);
  });

  it('ignores non-active items', () => {
    const onlyActive = computeMemoryVersion([
      { id: '1', key: 'a', updatedAt: '2026-09-12T00:00:00.000Z', status: 'active' },
    ]);
    const withArchived = computeMemoryVersion([
      { id: '1', key: 'a', updatedAt: '2026-09-12T00:00:00.000Z', status: 'active' },
      { id: '2', key: 'b', updatedAt: '2026-09-12T03:00:00.000Z', status: 'archived' },
    ]);
    expect(onlyActive).toBe(withArchived);
  });
});
