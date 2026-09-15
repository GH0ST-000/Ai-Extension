import { describe, expect, it } from 'vitest';

import { durationToMs, durationToSeconds } from './auth-cookies';

describe('auth-cookies duration helpers', () => {
  it('parses minute and day specs', () => {
    expect(durationToMs('15m', 0)).toBe(15 * 60_000);
    expect(durationToMs('7d', 0)).toBe(7 * 86_400_000);
    expect(durationToSeconds('15m', 0)).toBe(900);
  });

  it('falls back on invalid specs', () => {
    expect(durationToMs('nope', 1234)).toBe(1234);
  });
});
