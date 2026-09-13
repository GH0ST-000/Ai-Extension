import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';

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
    del: vi.fn(),
  };
  const errors = {
    toHttpException: vi.fn((code: string, message: string) => {
      const err = new Error(message) as Error & { code?: string };
      err.code = code;
      return err;
    }),
  };

  function fingerprintFor(body: string): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          owner: 'acme',
          repository: 'app',
          pullRequestNumber: 1,
          body,
        }),
      )
      .digest('hex');
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    githubConnections.getDecryptedToken.mockReset();
    redis.get.mockReset();
    redis.set.mockReset();
    redis.del.mockReset();
    redis.connect.mockReset();
    redis.status = 'ready';
    errors.toHttpException.mockClear();
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

    const service = new GithubWriteService(
      githubConnections as never,
      redis as never,
      errors as never,
    );
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
    const body = 'Hello review';
    redis.get.mockResolvedValue(
      JSON.stringify({
        fingerprint: fingerprintFor(body),
        success: true,
        commentId: 7,
        commentUrl: 'https://github.com/acme/app/pull/1#issuecomment-7',
      }),
    );

    const service = new GithubWriteService(
      githubConnections as never,
      redis as never,
      errors as never,
    );
    const result = await service.postPullRequestComment('user-1', {
      owner: 'acme',
      repository: 'app',
      pullRequestNumber: 1,
      body,
      idempotencyKey: 'same-key-01',
    });

    expect(result.deduplicated).toBe(true);
    expect(result.commentId).toBe(7);
    expect(githubConnections.getDecryptedToken).not.toHaveBeenCalled();
  });
});
