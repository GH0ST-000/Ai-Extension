import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RateLimiter, resetLocalRateLimitsForTests } from './rate-limiter';

describe('RateLimiter (N-15)', () => {
  beforeEach(() => resetLocalRateLimitsForTests());

  it('uses one atomic Redis script (increment + TTL together)', async () => {
    const counts = new Map<string, number>();
    const redis = {
      status: 'ready',
      incr: vi.fn(),
      expire: vi.fn(),
      eval: vi.fn(async (_script: string, _n: number, ...args: Array<string | number>) => {
        const key = String(args[0]);
        counts.set(key, (counts.get(key) ?? 0) + 1);
        return counts.get(key);
      }),
    };
    const limiter = new RateLimiter(redis);
    for (let i = 0; i < 3; i += 1) await limiter.consume('k', 3, 60);
    await expect(limiter.consume('k', 3, 60)).rejects.toMatchObject({ status: 429 });
    expect(redis.eval).toHaveBeenCalledWith(expect.stringContaining('PEXPIRE'), 1, 'k', 60_000);
    expect(redis.incr).not.toHaveBeenCalled(); // no separate, non-atomic INCR/EXPIRE
  });

  it('Redis outage: limits still apply (in-process fallback) — neither fail-open nor a total lockout', async () => {
    const down = {
      status: 'ready',
      incr: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
      expire: vi.fn(),
      eval: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    };
    const limiter = new RateLimiter(down);
    // Legitimate traffic within the limit passes during the outage…
    for (let i = 0; i < 5; i += 1) await limiter.consume('rl:ai:u:1', 5, 60);
    // …abuse beyond it is refused (previously the AI/invite/openapi buckets failed open).
    await expect(limiter.consume('rl:ai:u:1', 5, 60)).rejects.toMatchObject({ status: 429 });
    // Other keys are independent.
    await expect(limiter.consume('rl:ai:u:2', 5, 60)).resolves.toBeUndefined();
  });

  it('a HANGING Redis (offline queue / partition) falls back within the deadline instead of blocking', async () => {
    const hanging = {
      status: 'ready',
      incr: () => new Promise<number>(() => undefined),
      expire: async () => 1,
      eval: () => new Promise<unknown>(() => undefined),
    };
    const limiter = new RateLimiter(hanging);
    const started = Date.now();
    await limiter.consume('rl:auth:ip:1', 2, 60);
    expect(Date.now() - started).toBeLessThan(3_000);
    await limiter.consume('rl:auth:ip:1', 2, 60);
    await expect(limiter.consume('rl:auth:ip:1', 2, 60)).rejects.toMatchObject({ status: 429 });
  });

  it('concurrent requests over the limit are refused (local fallback is consistent)', async () => {
    const down = {
      incr: async () => Promise.reject(new Error('down')),
      expire: async () => undefined,
    };
    const limiter = new RateLimiter(down);
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => limiter.consume('burst', 10, 60)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10);
  });

  it('the fallback memory is bounded', async () => {
    const down = { incr: async () => Promise.reject(new Error('down')), expire: async () => 0 };
    const limiter = new RateLimiter(down);
    const started = Date.now();
    for (let i = 0; i < 120_000; i += 1) await limiter.consume(`k${i}`, 1, 60);
    // Amortized eviction keeps this linear (a per-insert scan would take minutes).
    expect(Date.now() - started).toBeLessThan(4_000);
    // No throw, no unbounded growth (the map is capped internally); new keys still work.
    await expect(limiter.consume('fresh', 1, 60)).resolves.toBeUndefined();
  });
});

describe('rateLimitAddressKey', () => {
  it('keys IPv4 on the address and IPv6 on the /64', async () => {
    const { rateLimitAddressKey: key } = await import('./rate-limiter');
    expect(key('203.0.113.9')).toBe('203.0.113.9');
    expect(key('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(key('2001:db8:abcd:12::1')).toBe(key('2001:0db8:ABCD:0012:ffff:ffff:ffff:ffff'));
    expect(key('2001:db8:abcd:12::1')).not.toBe(key('2001:db8:abcd:13::1'));
    expect(key('::1')).toBe(key('::2'));
    expect(key(undefined)).toBe('unknown');
    expect(key('')).toBe('unknown');
    expect(key('not an ip')).toBe('not an ip');
  });
});
