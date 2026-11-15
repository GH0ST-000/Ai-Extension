import { describe, expect, it } from 'vitest';

import { retryDelay as fixedDelay, syncAll as fixedSync } from './fixed/sync';
import { retryDelay as headDelay, syncAll as headSync } from './head/sync';

describe('fallback-and-async ground truth', () => {
  it('a configured delay of 0 is replaced', () => {
    expect(headDelay({ retryDelayMs: 0 })).toBe(1000);
    expect(fixedDelay({ retryDelayMs: 0 })).toBe(0);
  });

  it('syncAll resolves before the saves complete', async () => {
    const saved: string[] = [];
    const save = async (item: { id: string }) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      saved.push(item.id);
    };
    await headSync([{ id: 'a' }, { id: 'b' }], save);
    expect(saved).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    saved.length = 0;
    await fixedSync([{ id: 'a' }, { id: 'b' }], save);
    expect(saved).toEqual(['a', 'b']);
  });
});
