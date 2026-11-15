import { describe, expect, it } from 'vitest';

import { escapeRegExp } from './regexp';

describe('escapeRegExp', () => {
  it('escapes every metacharacter, including backslashes', () => {
    const nasty = String.raw`a\b$c.d*e+f?g^h{i}j(k)l|m[n]o`;
    expect(new RegExp(`^${escapeRegExp(nasty)}$`).test(nasty)).toBe(true);
    expect(new RegExp(escapeRegExp('\\')).test('\\')).toBe(true);
    expect(new RegExp(escapeRegExp('.')).test('x')).toBe(false);
  });

  it('leaves identifiers and markers matching exactly as before', () => {
    expect(escapeRegExp('$scope')).toBe('\\$scope');
    expect(escapeRegExp('deleteNote')).toBe('deleteNote');
    expect(escapeRegExp('[[px:review-coverage')).toBe('\\[\\[px:review-coverage');
  });
});
