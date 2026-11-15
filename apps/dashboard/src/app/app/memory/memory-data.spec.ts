import { beforeEach, describe, expect, it, vi } from 'vitest';

const listProjectMemory = vi.fn();
const getProjectMemoryProfile = vi.fn();
vi.mock('../../../lib/api', () => ({
  listProjectMemory: (...args: unknown[]) => listProjectMemory(...args),
  getProjectMemoryProfile: (...args: unknown[]) => getProjectMemoryProfile(...args),
}));

import { fetchMemory, memorySourceLabel } from './memory-data';

const item = (id: string, status: string) => ({ id, status });

describe('fetchMemory', () => {
  beforeEach(() => {
    listProjectMemory.mockReset().mockImplementation(async (_o, _r, status?: string) => ({
      items: [item(`${status ?? 'active'}-1`, status ?? 'active')],
      memoryVersion: 'pmv-1-x',
    }));
    getProjectMemoryProfile.mockReset().mockResolvedValue({ profile: 'p' });
  });

  it('loads active, disputed and archived rules as separate lists', async () => {
    const result = await fetchMemory('acme', 'app');
    expect(listProjectMemory.mock.calls.map((c) => c[2])).toEqual([
      undefined,
      'disputed',
      'archived',
    ]);
    expect(result.list.items.map((i: { id: string }) => i.id)).toEqual(['active-1']);
    expect(result.disputed.map((i) => i.id)).toEqual(['disputed-1']);
    expect(result.archived.map((i) => i.id)).toEqual(['archived-1']);
  });

  it('fails as a whole when any list fails (no partial, misleading view)', async () => {
    listProjectMemory.mockImplementation(async (_o, _r, status?: string) => {
      if (status === 'disputed') throw new Error('boom');
      return { items: [], memoryVersion: 'v' };
    });
    await expect(fetchMemory('acme', 'app')).rejects.toThrow('boom');
  });
});

describe('memorySourceLabel', () => {
  const at = '2026-11-14T00:00:00.000Z';
  it.each([
    [[{ type: 'user_explicit', observedAt: at }], 'Saved by a workspace member'],
    [[{ type: 'repository_observation', observedAt: at }], 'Learned from repository files'],
    [
      [
        { type: 'user_explicit', observedAt: at },
        { type: 'repository_observation', observedAt: at },
      ],
      'Saved by a workspace member',
    ],
    [[{ type: 'review_result', observedAt: at }], 'Suggested by a review'],
    [[], 'Unknown source'],
  ])('%j → %s', (provenance, label) => {
    expect(memorySourceLabel({ provenance } as never)).toBe(label);
  });
});
