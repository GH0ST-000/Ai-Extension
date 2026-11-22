import { Reflector } from '@nestjs/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { RATE_LIMIT_KEY, RateLimitGuard } from './rate-limit.guard';
import { resetLocalRateLimitsForTests } from './rate-limiter';

describe('RateLimitGuard per-workspace cap (N-9)', () => {
  const counts = new Map<string, number>();
  const redis = {
    status: 'ready',
    incr: async (key: string) => {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return counts.get(key)!;
    },
    expire: async () => 1,
  };
  const handler = () => undefined;
  Reflect.defineMetadata(
    RATE_LIMIT_KEY,
    { bucket: 'systems_scan', limit: 2, windowSeconds: 60, perWorkspaceLimit: 3 },
    handler,
  );
  const context = (userId: string, workspaceId: string) =>
    ({
      getHandler: () => handler,
      getClass: () => class {},
      switchToHttp: () => ({
        getRequest: () => ({ user: { id: userId }, workspace: { workspaceId }, headers: {} }),
      }),
    }) as never;

  beforeEach(() => {
    counts.clear();
    resetLocalRateLimitsForTests();
  });

  it('several members together cannot exceed the workspace budget', async () => {
    const guard = new RateLimitGuard(new Reflector(), redis as never);
    await guard.canActivate(context('u1', 'ws'));
    await guard.canActivate(context('u1', 'ws'));
    await guard.canActivate(context('u2', 'ws'));
    await expect(guard.canActivate(context('u2', 'ws'))).rejects.toMatchObject({ status: 429 });
    await expect(guard.canActivate(context('u3', 'other'))).resolves.toBe(true);
  });
});

describe('RateLimitGuard sustained window (Decision 1: registration spam)', () => {
  const counts = new Map<string, number>();
  const expiries = new Map<string, number>();
  const redis = {
    status: 'ready',
    incr: async (key: string) => {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return counts.get(key)!;
    },
    expire: async (key: string, seconds: number) => {
      expiries.set(key, seconds);
      return 1;
    },
  };
  const handler = () => undefined;
  Reflect.defineMetadata(
    RATE_LIMIT_KEY,
    {
      bucket: 'auth',
      limit: 100,
      windowSeconds: 60,
      sustained: { bucket: 'register_daily', limit: 3, windowSeconds: 86_400 },
    },
    handler,
  );
  const context = (ip: string) =>
    ({
      getHandler: () => handler,
      getClass: () => class {},
      switchToHttp: () => ({ getRequest: () => ({ ip, headers: {} }) }),
    }) as never;

  beforeEach(() => {
    counts.clear();
    expiries.clear();
    resetLocalRateLimitsForTests();
  });

  it('caps one IP over the long window, independently of the burst window; other IPs unaffected', async () => {
    const guard = new RateLimitGuard(new Reflector(), redis as never);
    for (let i = 0; i < 3; i += 1) await guard.canActivate(context('198.51.100.7'));
    await expect(guard.canActivate(context('198.51.100.7'))).rejects.toMatchObject({ status: 429 });
    await expect(guard.canActivate(context('198.51.100.8'))).resolves.toBe(true);
    // A window that expires (24 h), not a permanent ban.
    expect([...expiries.entries()].find(([k]) => k.includes('register_daily'))?.[1]).toBe(86_400);
  });
});
