import { HttpException, type ExecutionContext } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RATE_LIMIT_KEY, RateLimitGuard } from '../common/security/rate-limit.guard';
import { RELIABILITY_RATE_LIMITS, ReliabilityController } from './reliability.controller';

/** Deterministic in-memory stand-in for the Redis INCR/EXPIRE the guard uses. */
function fakeRedis() {
  const counts = new Map<string, number>();
  return {
    status: 'ready',
    connect: async () => undefined,
    incr: async (key: string) => {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    },
    expire: async () => 1,
  };
}

const handler = (name: keyof ReliabilityController) => ReliabilityController.prototype[name];

function context(name: keyof ReliabilityController, userId?: string): ExecutionContext {
  return {
    getHandler: () => handler(name),
    getClass: () => ReliabilityController,
    switchToHttp: () => ({
      getRequest: () => ({
        ...(userId ? { user: { id: userId } } : {}),
        ip: '10.0.0.1',
        headers: {},
      }),
    }),
  } as unknown as ExecutionContext;
}

async function hit(
  guard: RateLimitGuard,
  name: keyof ReliabilityController,
  userId: string,
  n: number,
) {
  let allowed = 0;
  let limited = 0;
  for (let i = 0; i < n; i += 1) {
    try {
      await guard.canActivate(context(name, userId));
      allowed += 1;
    } catch (error) {
      expect((error as HttpException).getStatus()).toBe(429);
      limited += 1;
    }
  }
  return { allowed, limited };
}

describe('Reliability endpoint rate limits', () => {
  const reflector = new Reflector();
  const policy = (name: keyof ReliabilityController) =>
    reflector.get(RATE_LIMIT_KEY, handler(name)) as { bucket: string; limit: number } | undefined;

  it('authentication runs before rate limiting on every endpoint', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, ReliabilityController)).toEqual([
      JwtAuthGuard,
      RateLimitGuard,
    ]);
  });

  it('creating endpoints are limited; read-only history is not', () => {
    expect(policy('start')).toEqual(RELIABILITY_RATE_LIMITS.start);
    for (const name of ['retry', 'resume', 'replay'] as const) {
      expect(policy(name)).toEqual(RELIABILITY_RATE_LIMITS.recovery);
    }
    for (const name of [
      'appendEvent',
      'checkpoint',
      'failure',
      'aiRequest',
      'lineage',
      'complete',
      'replayPreview',
    ] as const) {
      expect(policy(name)).toEqual(RELIABILITY_RATE_LIMITS.audit);
    }
    expect(policy('list')).toBeUndefined();
    expect(policy('get')).toBeUndefined();
  });

  it('allows requests within the limit and returns 429 beyond it', async () => {
    const guard = new RateLimitGuard(reflector, fakeRedis() as never);
    const { limit } = RELIABILITY_RATE_LIMITS.recovery;
    expect(await hit(guard, 'replay', 'user-a', limit + 3)).toEqual({ allowed: limit, limited: 3 });
    // Resume and retry share the recovery bucket.
    expect(await hit(guard, 'resume', 'user-a', 1)).toEqual({ allowed: 0, limited: 1 });
  });

  it('users are limited independently; reads stay available while limited', async () => {
    const guard = new RateLimitGuard(reflector, fakeRedis() as never);
    const { limit } = RELIABILITY_RATE_LIMITS.start;
    await hit(guard, 'start', 'user-a', limit + 1);
    expect(await hit(guard, 'start', 'user-b', 1)).toEqual({ allowed: 1, limited: 0 });
    expect(await hit(guard, 'list', 'user-a', 50)).toEqual({ allowed: 50, limited: 0 });
    expect(await hit(guard, 'get', 'user-a', 50)).toEqual({ allowed: 50, limited: 0 });
  });
});
