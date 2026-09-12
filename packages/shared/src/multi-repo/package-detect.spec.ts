import { describe, expect, it } from 'vitest';

import { findDependencyByName, parsePackageJsonManifest } from './package-detect';

describe('package-detect', () => {
  it('parses dependencies and repository field', () => {
    const raw = JSON.stringify({
      name: '@acme/payments-api',
      dependencies: {
        '@acme/shared-contracts': '^1.2.3',
        lodash: '4.17.21',
      },
      devDependencies: {
        vitest: '^1.0.0',
      },
      repository: {
        type: 'git',
        url: 'https://github.com/acme/payments-api.git',
      },
    });

    const parsed = parsePackageJsonManifest(raw);
    expect(parsed).not.toBeNull();
    expect(parsed?.name).toBe('@acme/payments-api');
    expect(findDependencyByName(parsed!, '@acme/shared-contracts')?.versionRange).toBe('^1.2.3');
    expect(parsed?.repository).toEqual(
      expect.objectContaining({
        owner: 'acme',
        repository: 'payments-api',
      }),
    );
  });

  it('returns null for invalid JSON', () => {
    expect(parsePackageJsonManifest('{nope')).toBeNull();
  });

  it('parses string repository URLs', () => {
    const parsed = parsePackageJsonManifest(
      JSON.stringify({
        name: 'x',
        repository: 'github.com/acme/web-checkout',
      }),
    );
    expect(parsed?.repository?.owner).toBe('acme');
    expect(parsed?.repository?.repository).toBe('web-checkout');
  });
});
