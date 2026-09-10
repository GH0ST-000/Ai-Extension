import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GithubErrorNormalizer } from './github-error-normalizer';
import { GithubPatchService } from './github-patch.service';
import { normalizeRepositoryPath } from './patch-path';

describe('normalizeRepositoryPath', () => {
  it('accepts relative paths', () => {
    expect(normalizeRepositoryPath('src/payment/service.ts')).toBe('src/payment/service.ts');
  });

  it('rejects traversal and absolute paths', () => {
    expect(normalizeRepositoryPath('../secret')).toBeNull();
    expect(normalizeRepositoryPath('/etc/passwd')).toBeNull();
    expect(normalizeRepositoryPath('foo/../../bar')).toBeNull();
  });
});

describe('GithubPatchService', () => {
  const githubConnections = { getDecryptedToken: vi.fn() };
  const redis = {
    status: 'ready' as string,
    connect: vi.fn(),
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
  };
  const errors = new GithubErrorNormalizer();

  beforeEach(() => {
    vi.restoreAllMocks();
    githubConnections.getDecryptedToken.mockReset();
    redis.get.mockReset();
    redis.set.mockReset();
    redis.del.mockReset();
    redis.status = 'ready';
  });

  it('prepares a single-file modify without writing', async () => {
    githubConnections.getDecryptedToken.mockResolvedValue('ghs_test');
    redis.set.mockResolvedValue('OK');

    const original = 'const x = 1\n';
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            number: 12,
            state: 'open',
            merged: false,
            head: {
              sha: 'abc123',
              ref: 'fix/payment',
              repo: { name: 'app', owner: { login: 'acme' } },
            },
            base: {
              ref: 'main',
              repo: { name: 'app', owner: { login: 'acme' } },
            },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            type: 'file',
            encoding: 'base64',
            sha: 'blob1',
            size: original.length,
            content: Buffer.from(original, 'utf8').toString('base64'),
          }),
        }),
    );

    const service = new GithubPatchService(githubConnections as never, redis as never, errors);

    const prepared = await service.preparePullRequestPatch('user-1', 'acme', 'app', 12, {
      path: 'src/a.ts',
      newContent: 'const x = 2\n',
      commitMessage: 'fix: update a',
    });

    expect(prepared.files).toHaveLength(1);
    expect(prepared.files[0]?.operation).toBe('modify');
    expect(prepared.expectedHeadSha).toBe('abc123');
    expect(prepared.headRef).toBe('fix/payment');
    expect(redis.set).toHaveBeenCalled();
    // Only GET calls — no PUT
    expect(
      vi.mocked(fetch).mock.calls.every((call) => (call[1] as RequestInit)?.method !== 'PUT'),
    ).toBe(true);
  });

  it('blocks apply when PR head changed', async () => {
    githubConnections.getDecryptedToken.mockResolvedValue('ghs_test');
    const stored = {
      preparedPatchId: 'prep-1',
      userId: 'user-1',
      owner: 'acme',
      repository: 'app',
      pullRequestNumber: 12,
      headOwner: 'acme',
      headRepository: 'app',
      headRef: 'fix/payment',
      expectedHeadSha: 'oldsha',
      baseOwner: 'acme',
      baseRepository: 'app',
      baseRef: 'main',
      path: 'src/a.ts',
      expectedBlobSha: 'blob1',
      originalContent: 'a',
      newContent: 'b',
      fingerprint: 'fp',
      defaultCommitMessage: 'fix',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    redis.get.mockImplementation(async (key: string) => {
      if (String(key).includes('prep')) {
        return JSON.stringify(stored);
      }
      return null;
    });
    redis.set.mockResolvedValue('OK');

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          number: 12,
          state: 'open',
          merged: false,
          head: {
            sha: 'newsha',
            ref: 'fix/payment',
            repo: { name: 'app', owner: { login: 'acme' } },
          },
          base: { ref: 'main', repo: { name: 'app', owner: { login: 'acme' } } },
        }),
      }),
    );

    const service = new GithubPatchService(githubConnections as never, redis as never, errors);

    await expect(
      service.applyPullRequestPatch('user-1', 'acme', 'app', 12, {
        preparedPatchId: 'prep-1',
        commitMessage: 'fix',
        clientRequestId: 'req-1-aaaa',
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
