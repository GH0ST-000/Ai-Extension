import { describe, expect, it } from 'vitest';

import { normalizeRepositoryPath } from './patch-path';

describe('Day 29 patch path security', () => {
  it('allows nested repository-relative paths', () => {
    expect(normalizeRepositoryPath('src/payment/service.ts')).toBe('src/payment/service.ts');
  });

  it('rejects traversal and absolute forms', () => {
    expect(normalizeRepositoryPath('../secret')).toBeNull();
    expect(normalizeRepositoryPath('../../etc/passwd')).toBeNull();
    expect(normalizeRepositoryPath('/etc/passwd')).toBeNull();
    expect(normalizeRepositoryPath('C:\\windows\\system32')).toBeNull();
    expect(normalizeRepositoryPath('foo/../../bar')).toBeNull();
    expect(normalizeRepositoryPath('foo\0bar')).toBeNull();
  });

  it('rejects URL-encoded traversal', () => {
    expect(normalizeRepositoryPath('%2e%2e/secret')).toBeNull();
    expect(normalizeRepositoryPath('foo/%2e%2e/%2e%2e/bar')).toBeNull();
  });
});
