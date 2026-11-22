import { isIPv6 } from 'node:net';

import { HttpException, HttpStatus, Logger } from '@nestjs/common';

type CounterStore = {
  status?: string;
  connect?: () => Promise<unknown>;
  incr: (key: string) => Promise<number>;
  expire: (key: string, seconds: number) => Promise<unknown>;
  eval?: (script: string, numKeys: number, ...args: Array<string | number>) => Promise<unknown>;
};

/** INCR and set the TTL atomically (a crash can never leave a counter without expiry). */
const INCR_WITH_TTL = `
local c = redis.call('INCR', KEYS[1])
if c == 1 or redis.call('PTTL', KEYS[1]) < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
return c`;

/** Upper bound of keys kept by the in-process fallback (memory stays bounded). */
const FALLBACK_MAX_KEYS = 50_000;

const fallback = new Map<string, { count: number; resetAt: number }>();
const logger = new Logger('RateLimiter');
let lastFallbackLog = 0;

function consumeLocally(key: string, windowSeconds: number): number {
  const now = Date.now();
  if (fallback.size >= FALLBACK_MAX_KEYS) {
    // Amortized eviction: one pass drops expired entries, then the oldest (insertion order)
    // down to 90% — so a full pass happens at most once per FALLBACK_MAX_KEYS / 10 inserts.
    const target = Math.floor(FALLBACK_MAX_KEYS * 0.9);
    for (const [k, v] of fallback) if (v.resetAt <= now) fallback.delete(k);
    for (const k of fallback.keys()) {
      if (fallback.size <= target) break;
      fallback.delete(k);
    }
  }
  const entry = fallback.get(key);
  if (!entry || entry.resetAt <= now) {
    fallback.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
    return 1;
  }
  entry.count += 1;
  return entry.count;
}

/**
 * The part of a client address a rate limit is keyed on. IPv4: the address. IPv6: the /64
 * network — one subscriber routinely controls a whole /64, so keying on the full address
 * would hand every IPv6 client an unlimited supply of "different" addresses. IPv4-mapped IPv6
 * is keyed as its IPv4 address. Unknown input is one shared bucket.
 */
export function rateLimitAddressKey(ip: string | null | undefined): string {
  const raw = typeof ip === 'string' ? ip.trim().toLowerCase().split('%')[0]! : '';
  if (!raw) return 'unknown';
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(raw);
  if (mapped) return mapped[1]!;
  if (!isIPv6(raw)) return raw;
  const [head = '', tail] = raw.split('::') as [string, string | undefined];
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups =
    tail === undefined
      ? left
      : [
          ...left,
          ...new Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'),
          ...right,
        ];
  return `${groups
    .slice(0, 4)
    .map((g) => (g.includes('.') ? g : (Number.parseInt(g, 16) || 0).toString(16)))
    .join(':')}::/64`;
}

export function rateLimitedException(): HttpException {
  return new HttpException(
    {
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      code: 'RATE_LIMITED',
      message: 'Too many requests. Please wait and try again.',
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

/**
 * Fixed-window rate limiting (N-15). Redis is the shared, cross-instance store (atomic
 * increment + TTL). When Redis is unavailable every bucket falls back to an in-process limiter
 * with the SAME limits — bounded and documented: limits then apply per API instance (at most
 * N× the limit with N instances) instead of failing open (no limit at all) or failing closed
 * (every login refused for the whole outage).
 */
export class RateLimiter {
  constructor(private readonly redis: CounterStore) {}

  private async remoteCount(key: string, windowSeconds: number): Promise<number> {
    if (this.redis.status === 'wait' && this.redis.connect) await this.redis.connect();
    if (typeof this.redis.eval === 'function') {
      return Number(await this.redis.eval(INCR_WITH_TTL, 1, key, windowSeconds * 1000));
    }
    // Minimal stores (tests): same semantics without atomicity.
    const count = await this.redis.incr(key);
    if (count === 1) await this.redis.expire(key, windowSeconds);
    return count;
  }

  /** Throws 429 when `key` exceeded `limit` within `windowSeconds`. */
  async consume(key: string, limit: number, windowSeconds: number): Promise<void> {
    let count: number;
    try {
      // Bounded: a Redis that hangs (offline queue, network partition) counts as unavailable
      // and the local fallback applies — requests never wait on Redis (adversarial review N2).
      count = await withDeadline(this.remoteCount(key, windowSeconds), REDIS_DEADLINE_MS);
      if (!Number.isFinite(count)) throw new Error('invalid counter');
    } catch {
      count = consumeLocally(key, windowSeconds);
      if (Date.now() - lastFallbackLog > 60_000) {
        lastFallbackLog = Date.now();
        logger.warn({ msg: 'rate_limit.redis_unavailable_local_fallback' });
      }
    }
    if (count > limit) throw rateLimitedException();
  }
}

const REDIS_DEADLINE_MS = 1_500;

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('redis deadline exceeded')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Test hook: forget the in-process fallback counters. */
export function resetLocalRateLimitsForTests(): void {
  fallback.clear();
}
