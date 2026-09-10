import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GithubWriteService } from './github-write.service';

describe('GithubWriteService', () => {
  const githubConnections = {
    getDecryptedToken: vi.fn(),
  };
  const redis = {
    status: 'ready' as string,
    connect: vi.fn(),
    get: vi.fn(),
    set: vi.fn(),
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    githubConnections.getDecryptedToken.mockReset();
    redis.get.mockReset();
    redis.set.mockReset();
    redis.connect.mockReset();
    redis.status = 'ready';
  });

  it('posts a PR comment and stores idempotency result', async () => {
    githubConnections.getDecryptedToken.mockResolvedValue('ghs_test');
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue('OK');

    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            number: 1,
            state: 'open',
            merged: false,
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 201,
          json: async () => ({
            id: 42,
            html_url: 'https://github.com/acme/app/pull/1#issuecomment-42',
          }),
        }),
    );

    const service = new GithubWriteService(githubConnections as never, redis as never);
    const result = await service.postPullRequestComment('user-1', {
      owner: 'acme',
      repository: 'app',
      pullRequestNumber: 1,
      body: 'Hello review',
      idempotencyKey: 'abc-123-def',
    });

    expect(result).toEqual({
      success: true,
      commentId: 42,
      commentUrl: 'https://github.com/acme/app/pull/1#issuecomment-42',
      deduplicated: false,
    });
    expect(redis.set).toHaveBeenCalled();
  });

  it('returns cached result for the same idempotency key', async () => {
    redis.get.mockResolvedValue(
      JSON.stringify({
        success: true,
        commentId: 7,
        commentUrl: 'https://github.com/acme/app/pull/1#issuecomment-7',
      }),
    );

    const service = new GithubWriteService(githubConnections as never, redis as never);
    const result = await service.postPullRequestComment('user-1', {
      owner: 'acme',
      repository: 'app',
      pullRequestNumber: 1,
      body: 'Hello review',
      idempotencyKey: 'same-key-01',
    });

    expect(result.deduplicated).toBe(true);
    expect(result.commentId).toBe(7);
    expect(githubConnections.getDecryptedToken).not.toHaveBeenCalled();
  });
});
