import { describe, expect, it } from 'vitest';

import {
  normalizeOwnerRepo,
  parseOwnerRepo,
  repositoryKey,
  sameRepository,
  toRepositoryIdentity,
} from './identity';

describe('multi-repo identity', () => {
  it('normalizes owner/repo to lowercase', () => {
    expect(normalizeOwnerRepo('Acme', 'Payments-API')).toEqual({
      owner: 'acme',
      repository: 'payments-api',
    });
  });

  it('parses owner/repo and GitHub URLs', () => {
    expect(parseOwnerRepo('acme/payments-api')).toEqual({
      owner: 'acme',
      repository: 'payments-api',
    });
    expect(parseOwnerRepo('https://github.com/Acme/payment-worker.git')).toEqual({
      owner: 'acme',
      repository: 'payment-worker',
    });
    expect(parseOwnerRepo('not-a-repo')).toBeNull();
    expect(parseOwnerRepo('a/b/c')).toBeNull();
  });

  it('builds stable repository keys', () => {
    expect(repositoryKey({ owner: 'Acme', repository: 'Web' })).toBe('github:acme/web');
    expect(repositoryKey({ provider: 'github', owner: 'acme', repository: 'web' })).toBe(
      'github:acme/web',
    );
  });

  it('matches by repositoryId when both present, else by key', () => {
    expect(
      sameRepository(
        { provider: 'github', owner: 'acme', repository: 'a', repositoryId: '1' },
        { provider: 'github', owner: 'acme', repository: 'renamed', repositoryId: '1' },
      ),
    ).toBe(true);
    expect(
      sameRepository(
        { provider: 'github', owner: 'acme', repository: 'a' },
        { provider: 'github', owner: 'acme', repository: 'a' },
      ),
    ).toBe(true);
    expect(
      sameRepository(
        { provider: 'github', owner: 'acme', repository: 'a' },
        { provider: 'github', owner: 'acme', repository: 'b' },
      ),
    ).toBe(false);
  });

  it('builds RepositoryIdentity', () => {
    expect(toRepositoryIdentity('Acme', 'API', '99')).toEqual({
      provider: 'github',
      owner: 'acme',
      repository: 'api',
      repositoryId: '99',
    });
  });
});
