import { describe, expect, it } from 'vitest';

import { computeSystemContextVersion } from './version';
import { toRepositoryIdentity } from './identity';

describe('computeSystemContextVersion', () => {
  const baseRepos = [
    {
      repository: toRepositoryIdentity('acme', 'payments-api'),
      enabled: true,
      role: 'backend',
      headSha: 'aaa',
    },
    {
      repository: toRepositoryIdentity('acme', 'web-checkout'),
      enabled: true,
      role: 'frontend',
      headSha: 'bbb',
    },
  ];

  it('is stable regardless of repository order', () => {
    const a = computeSystemContextVersion({
      systemId: 'sys-1',
      repositories: baseRepos,
    });
    const b = computeSystemContextVersion({
      systemId: 'sys-1',
      repositories: [...baseRepos].reverse(),
    });
    expect(a).toBe(b);
    expect(a.startsWith('scv-2-0-')).toBe(true);
  });

  it('changes when membership or heads change', () => {
    const before = computeSystemContextVersion({
      systemId: 'sys-1',
      repositories: baseRepos,
    });
    const after = computeSystemContextVersion({
      systemId: 'sys-1',
      repositories: [baseRepos[0]!, { ...baseRepos[1]!, headSha: 'ccc' }],
    });
    expect(before).not.toBe(after);
  });

  it('includes active relationships in the fingerprint', () => {
    const without = computeSystemContextVersion({
      systemId: 'sys-1',
      repositories: baseRepos,
      relationships: [],
    });
    const withRel = computeSystemContextVersion({
      systemId: 'sys-1',
      repositories: baseRepos,
      relationships: [
        {
          id: 'rel-1',
          type: 'HTTP_CALLS',
          status: 'active',
          from: toRepositoryIdentity('acme', 'web-checkout'),
          to: toRepositoryIdentity('acme', 'payments-api'),
          resource: { kind: 'http_operation', key: 'POST /payments/{id}/retry' },
        },
      ],
    });
    expect(without).not.toBe(withRel);
    expect(withRel.startsWith('scv-2-1-')).toBe(true);
  });
});
