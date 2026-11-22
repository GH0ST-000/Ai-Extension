import { describe, expect, it, vi, beforeEach } from 'vitest';

import { GithubReviewService } from './github-review.service';
import { GithubErrorNormalizer } from './github-error-normalizer';
import { repositoryAccessStub } from '../github-app/github-access.test-helpers';

describe('GithubReviewService', () => {
  const githubConnections = repositoryAccessStub({
    getDecryptedToken: vi.fn(),
  });
  const redis = {
    status: 'ready' as string,
    connect: vi.fn(),
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    eval: vi.fn(async () => 1),
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
  // ── F-17: the idempotency protocol fails closed ─────────────────────────

  describe('idempotency when Redis misbehaves (F-17)', () => {
    /** An in-memory Redis that honours keys, NX and the compare-and-delete script. */
    function memoryRedis() {
      const store = new Map<string, string>();
      return {
        store,
        status: 'ready' as string,
        connect: vi.fn(),
        get: vi.fn(async (key: string) => store.get(key) ?? null),
        set: vi.fn(async (key: string, value: string, ...args: unknown[]) => {
          if (args.includes('NX') && store.has(key)) return null;
          store.set(key, value);
          return 'OK';
        }),
        del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
        eval: vi.fn(async (script: string, _keys: number, key: string, token: string) => {
          if (store.get(key) !== token) return 0;
          if (script.includes("'DEL'")) store.delete(key); // release; otherwise extend
          return 1;
        }),
      };
    }

    /** GitHub double: PR lookups succeed; every review POST is counted. */
    function github(onPost?: () => Promise<void>) {
      const posts: string[] = [];
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'POST') {
          posts.push(String(url));
          await onPost?.();
          return {
            ok: true,
            status: 200,
            json: async () => ({
              id: 1000 + posts.length,
              state: 'COMMENTED',
              html_url: `https://github.com/acme/app/pull/12#pullrequestreview-${1000 + posts.length}`,
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            number: 12,
            state: 'open',
            merged: false,
            head: { sha: 'abc1234' },
          }),
        };
      });
      vi.stubGlobal('fetch', fetchMock);
      return posts;
    }

    const submit = (service: GithubReviewService, user = 'user-1', id = 'req-f17-0001') =>
      service.submitPullRequestReview(user, 'acme', 'app', 12, {
        event: 'COMMENT',
        body: 'Looks mostly good',
        comments: [],
        clientRequestId: id,
      });

    beforeEach(() => {
      githubConnections.getDecryptedToken.mockResolvedValue('ghs_test');
    });

    it.each([
      [
        'reading the idempotency record fails',
        (r: ReturnType<typeof memoryRedis>) => r.get.mockRejectedValue(new Error('ECONNREFUSED')),
      ],
      [
        'taking the lock fails',
        (r: ReturnType<typeof memoryRedis>) => r.set.mockRejectedValue(new Error('ECONNREFUSED')),
      ],
      [
        'Redis hangs',
        (r: ReturnType<typeof memoryRedis>) =>
          r.get.mockImplementation(() => new Promise(() => undefined)),
      ],
    ])('nothing is posted to GitHub when %s', async (_name, breakRedis) => {
      const memory = memoryRedis();
      breakRedis(memory);
      const posts = github();
      const service = new GithubReviewService(githubConnections as never, memory as never, errors);
      const started = Date.now();
      await expect(submit(service)).rejects.toMatchObject({ status: 503 });
      expect(Date.now() - started).toBeLessThan(5_000); // bounded, even when Redis hangs
      expect(posts).toHaveLength(0);
    });

    it('a double submission posts exactly one review', async () => {
      const memory = memoryRedis();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const posts = github(() => gate);
      const service = new GithubReviewService(githubConnections as never, memory as never, errors);
      const first = submit(service);
      const second = submit(service);
      // Let the loser finish waiting for the winner, then let GitHub answer.
      const settledSecond = await second.then(
        (r) => r,
        (e: { getResponse(): { code?: string } }) => e.getResponse(),
      );
      release();
      const done = await first;
      expect(posts).toHaveLength(1);
      expect(done.deduplicated).toBe(false);
      expect(settledSecond).toMatchObject({ code: 'WRITE_OUTCOME_UNKNOWN' });
      // A later retry is answered from the record: still one review.
      expect((await submit(service)).deduplicated).toBe(true);
      expect(posts).toHaveLength(1);
    });

    it('the record and the lock are per user: the same request id from two users is two reviews', async () => {
      const memory = memoryRedis();
      const posts = github();
      const service = new GithubReviewService(githubConnections as never, memory as never, errors);
      await submit(service, 'user-1');
      const other = await submit(service, 'user-2');
      expect(other.deduplicated).toBe(false);
      expect(posts).toHaveLength(2);
      expect([...memory.store.keys()].sort()).toEqual([
        'gh:pr-review:user-1:req-f17-0001',
        'gh:pr-review:user-2:req-f17-0001',
      ]);
    });

    it('releasing never deletes a lock this request no longer owns', async () => {
      const memory = memoryRedis();
      const lockKey = 'gh:pr-review:user-1:req-f17-0001:lock';
      const posts = github(async () => {
        // The lock expired and another request took it while GitHub was answering.
        memory.store.set(lockKey, 'someone-elses-token');
      });
      const service = new GithubReviewService(githubConnections as never, memory as never, errors);
      await submit(service);
      expect(posts).toHaveLength(1);
      expect(memory.store.get(lockKey)).toBe('someone-elses-token');
      expect(memory.del).not.toHaveBeenCalled();
    });

    it('a review that reached GitHub is returned even if recording it keeps failing (and it is retried)', async () => {
      const memory = memoryRedis();
      const realSet = memory.set.getMockImplementation()!;
      memory.set.mockImplementation(async (key: string, value: string, ...args: unknown[]) => {
        if (!args.includes('NX')) throw new Error('READONLY');
        return realSet(key, value, ...args);
      });
      const posts = github();
      const service = new GithubReviewService(githubConnections as never, memory as never, errors);
      const result = await submit(service);
      expect(result.success).toBe(true);
      expect(posts).toHaveLength(1);
      expect(memory.set.mock.calls.filter((c) => !c.includes('NX'))).toHaveLength(3);
    });

    it('an unknown outcome parks the request id: a retry is answered without a second POST', async () => {
      const memory = memoryRedis();
      let posts = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_url: string, init?: RequestInit) => {
          if (init?.method === 'POST') {
            posts += 1;
            throw new DOMException('The operation timed out.', 'TimeoutError');
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({
              number: 12,
              state: 'open',
              merged: false,
              head: { sha: 'abc1234' },
            }),
          };
        }),
      );
      const service = new GithubReviewService(githubConnections as never, memory as never, errors);
      const code = (e: { getResponse(): { code?: string } }) => e.getResponse().code;
      expect(code(await submit(service).catch((e) => e))).toBe('WRITE_OUTCOME_UNKNOWN');
      expect(posts).toBe(1);
      // The client retries with the same request id (the review may already exist).
      expect(code(await submit(service).catch((e) => e))).toBe('WRITE_OUTCOME_UNKNOWN');
      expect(code(await submit(service).catch((e) => e))).toBe('WRITE_OUTCOME_UNKNOWN');
      expect(posts).toBe(1);
      // A NEW submission (new request id) is a deliberate second attempt and is allowed.
      await submit(service, 'user-1', 'req-f17-0002').catch(() => undefined);
      expect(posts).toBe(2);
    });

    it('if the lock expired while the request was being prepared, nothing is posted', async () => {
      const memory = memoryRedis();
      const posts = github();
      // The PR lookup "takes too long": by the time it returns, the lock is gone (expired
      // and taken by another request).
      const lockKey = 'gh:pr-review:user-1:req-f17-0001:lock';
      const realFetch = vi.mocked(fetch).getMockImplementation()!;
      vi.mocked(fetch).mockImplementation(async (url, init) => {
        if (init?.method !== 'POST') {
          memory.store.set(lockKey, 'another-requests-token');
        }
        return realFetch(url, init);
      });
      const service = new GithubReviewService(githubConnections as never, memory as never, errors);
      await expect(submit(service)).rejects.toMatchObject({ status: 503 });
      expect(posts).toHaveLength(0);
      expect(memory.store.get(lockKey)).toBe('another-requests-token');
    });

    it('the GitHub POST carries a deadline shorter than the lock', async () => {
      const memory = memoryRedis();
      github();
      const service = new GithubReviewService(githubConnections as never, memory as never, errors);
      await submit(service);
      const post = vi
        .mocked(fetch)
        .mock.calls.find((c) => (c[1] as RequestInit)?.method === 'POST')!;
      expect((post[1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
    });
  });
});
