import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOpaqueId } from './hash';

afterEach(() => vi.unstubAllGlobals());

describe('createOpaqueId', () => {
  it('uses crypto.randomUUID: prefix + 32 hex chars, unique', () => {
    const ids = new Set(Array.from({ length: 200 }, () => createOpaqueId('wex_')));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^wex_[0-9a-f]{32}$/);
  });

  it('falls back to crypto.getRandomValues (browsers without a secure context)', () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => bytes.fill(0xab));
    vi.stubGlobal('crypto', { getRandomValues });
    expect(createOpaqueId('req_')).toBe(`req_${'ab'.repeat(16)}`);
    expect(getRandomValues).toHaveBeenCalledTimes(1);
  });

  it('never uses Math.random; without a secure generator it fails loudly', () => {
    const random = vi.spyOn(Math, 'random');
    vi.stubGlobal('crypto', undefined);
    expect(() => createOpaqueId('req_')).toThrow('Secure random generator unavailable');
    vi.unstubAllGlobals();
    createOpaqueId('req_');
    expect(random).not.toHaveBeenCalled();
    random.mockRestore();
  });
});
