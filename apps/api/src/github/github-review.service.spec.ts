import { describe, expect, it, vi, beforeEach } from 'vitest';

import { GithubReviewService } from './github-review.service';
import { GithubErrorNormalizer } from './github-error-normalizer';

describe('GithubReviewService', () => {
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
  const errors = new GithubErrorNormalizer();

  beforeEach(() => {
    vi.restoreAllMocks();
    githubConnections.getDecryptedToken.mockReset();
    redis.get.mockReset();
    redis.set.mockReset();
    redis.del.mockReset();
    redis.connect.mockReset();
    redis.status = 'ready';
  });

  it('submits a COMMENT review and stores idempotent success', async () => {
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
            number: 12,
            state: 'open',
            merged: false,
            head: { sha: 'abc1234' },
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            id: 99,
            state: 'COMMENTED',
            html_url: 'https://github.com/acme/app/pull/12#pullrequestreview-99',
            submitted_at: '2026-09-10T12:00:00Z',
          }),
        }),
    );

    const service = new GithubReviewService(githubConnections as never, redis as never, errors);

    const result = await service.submitPullRequestReview('user-1', 'acme', 'app', 12, {
      event: 'COMMENT',
      body: 'Looks mostly good',
      comments: [],
      clientRequestId: 'req-1111-aaaa',
    });

    expect(result.success).toBe(true);
    expect(result.reviewId).toBe(99);
    expect(result.deduplicated).toBe(false);
    expect(result.reviewUrl).toContain('github.com');
  });

  it('replays the same clientRequestId + fingerprint without calling GitHub again', async () => {
    redis.get.mockResolvedValue(
      JSON.stringify({
        kind: 'success',
        fingerprint: expect.any(String),
        result: {
          success: true,
          reviewId: 7,
          state: 'COMMENTED',
          reviewUrl: 'https://github.com/acme/app/pull/12#pullrequestreview-7',
          submittedAt: '2026-09-10T12:00:00Z',
          commentCount: 0,
        },
      }),
    );

    // Seed with exact fingerprint by computing through a first successful path is complex;
    // instead mock get to return matching fingerprint from a prior store.
    const service = new GithubReviewService(githubConnections as never, redis as never, errors);

    // First call to build fingerprint, then set redis to that fingerprint
    githubConnections.getDecryptedToken.mockResolvedValue('ghs_test');
    redis.get.mockResolvedValue(null);
    redis.set.mockImplementation(async (key: string, value: string) => {
      if (!key.endsWith(':lock')) {
        redis.get.mockResolvedValue(value);
      }
      return 'OK';
    });

    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ number: 12, state: 'open', merged: false, head: { sha: 'abc' } }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            id: 7,
            state: 'COMMENTED',
            html_url: 'https://github.com/acme/app/pull/12#pullrequestreview-7',
            submitted_at: '2026-09-10T12:00:00Z',
          }),
        }),
    );

    const payload = {
      event: 'COMMENT' as const,
      body: 'Replay me',
      comments: [],
      clientRequestId: 'req-replay-01',
    };

    const first = await service.submitPullRequestReview('user-1', 'acme', 'app', 12, payload);
    const second = await service.submitPullRequestReview('user-1', 'acme', 'app', 12, payload);

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.reviewId).toBe(7);
  });

  it('rejects empty COMMENT reviews', async () => {
    const service = new GithubReviewService(githubConnections as never, redis as never, errors);
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue('OK');

    await expect(
      service.submitPullRequestReview('user-1', 'acme', 'app', 12, {
        event: 'COMMENT',
        body: '',
        comments: [],
        clientRequestId: 'req-empty-01',
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('aggregates PR-level notes into the review body', async () => {
    githubConnections.getDecryptedToken.mockResolvedValue('ghs_test');
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue('OK');

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ number: 3, state: 'open', merged: false, head: { sha: 'deadbeef' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          id: 5,
          state: 'COMMENTED',
          html_url: 'https://github.com/acme/app/pull/3#pullrequestreview-5',
          submitted_at: '2026-09-10T12:00:00Z',
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const service = new GithubReviewService(githubConnections as never, redis as never, errors);

    await service.submitPullRequestReview('user-1', 'acme', 'app', 3, {
      event: 'COMMENT',
      body: 'Overview',
      comments: [{ body: 'Check auth', path: 'src/auth.ts' }],
      clientRequestId: 'req-agg-01',
    });

    const reviewCall = fetchMock.mock.calls[1];
    expect(reviewCall).toBeDefined();
    const body = JSON.parse((reviewCall as [string, RequestInit])[1].body as string) as {
      body: string;
      comments?: unknown[];
    };
    expect(body.body).toContain('Additional review notes');
    expect(body.body).toContain('src/auth.ts');
    expect(body.comments).toBeUndefined();
  });
});
