import { describe, expect, it } from 'vitest';

import {
  assertNoInventedRepositories,
  validateAnalysisRepositorySelection,
  validateRepositoriesInScope,
} from './validate';
import { toRepositoryIdentity } from './identity';

describe('multi-repo validate', () => {
  const allowed = [
    toRepositoryIdentity('acme', 'payments-api'),
    toRepositoryIdentity('acme', 'web-checkout'),
    toRepositoryIdentity('acme', 'payment-worker'),
  ];

  it('splits in-scope vs out-of-scope repositories', () => {
    const result = validateRepositoriesInScope(
      [toRepositoryIdentity('acme', 'payments-api'), toRepositoryIdentity('acme', 'other')],
      allowed,
    );
    expect(result.inScope).toHaveLength(1);
    expect(result.outOfScope).toHaveLength(1);
  });

  it('rejects invented repositories outside system scope', () => {
    const result = validateAnalysisRepositorySelection(
      [{ owner: 'acme', repository: 'not-in-system' }],
      allowed,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('SYSTEM_REPOSITORY_NOT_ACCESSIBLE');
    }
  });

  it('enforces analysis repository budget', () => {
    const result = validateAnalysisRepositorySelection(allowed, allowed, 2);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('SYSTEM_REPOSITORY_LIMIT_REACHED');
    }
  });

  it('accepts valid scoped selections', () => {
    const result = validateAnalysisRepositorySelection(
      [{ owner: 'Acme', repository: 'Payments-API' }],
      allowed,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.repository).toBe('payments-api');
    }
  });

  it('assertNoInventedRepositories fails closed', () => {
    const result = assertNoInventedRepositories([toRepositoryIdentity('evil', 'corp')], allowed);
    expect(result.ok).toBe(false);
  });
});
