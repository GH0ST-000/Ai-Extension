/**
 * F-15: the per-account login throttle must not let one client lock an account's owner out.
 * Real AuthController.login + real RateLimiter over an in-memory counter store; the password
 * check is a stub (only "victim-password" is right).
 */
import { UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';

import { resetLocalRateLimitsForTests } from '../common/security/rate-limiter';
import {
  AuthController,
  LOGIN_ATTEMPTS_PER_ACCOUNT,
  LOGIN_ATTEMPTS_PER_ACCOUNT_ALL_CLIENTS,
} from './auth.controller';

const VICTIM = 'victim@example.com';

function build() {
  const counters = new Map<string, number>();
  const redis = {
    status: 'ready',
    incr: async (key: string) => {
      const next = (counters.get(key) ?? 0) + 1;
      counters.set(key, next);
      return next;
    },
    expire: async () => 1,
  };
  const authService = {
    login: async (body: { email: string; password: string }) => {
      if (body.email === VICTIM && body.password === 'victim-password') {
        return {
          accessToken: 'a',
          refreshToken: 'r',
          expiresIn: 900,
          user: { id: 'u', email: VICTIM, name: null },
        };
      }
      throw new UnauthorizedException('Invalid credentials.');
    },
  };
  const config = { get: (key: string) => (key === 'nodeEnv' ? 'test' : '15m') };
  const controller = new AuthController(
    authService as never,
    config as never,
    {} as never,
    redis as never,
    {} as never,
  );
  const attempt = async (ip: string, password: string, email = VICTIM) => {
    const res = { cookie: () => undefined, clearCookie: () => undefined };
    try {
      await controller.login(
        { email, password } as never,
        { ip, headers: {} } as never,
        res as never,
      );
      return 200;
    } catch (error) {
      return (error as { getStatus(): number }).getStatus();
    }
  };
  return { attempt };
}

describe('login throttling (F-15)', () => {
  beforeEach(() => resetLocalRateLimitsForTests());

  it('wrong passwords from one address do not lock the owner out from another address', async () => {
    const { attempt } = build();
    const statuses: number[] = [];
    for (let i = 0; i < LOGIN_ATTEMPTS_PER_ACCOUNT + 5; i += 1) {
      statuses.push(await attempt('203.0.113.9', `guess-${i}`));
    }
    // The attacker is throttled on this account…
    expect(statuses.slice(0, LOGIN_ATTEMPTS_PER_ACCOUNT).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(LOGIN_ATTEMPTS_PER_ACCOUNT).every((s) => s === 429)).toBe(true);
    // …and the owner still signs in.
    expect(await attempt('198.51.100.20', 'victim-password')).toBe(200);
  });

  it('the throttled address stays throttled even with the right password (guessing bound)', async () => {
    const { attempt } = build();
    for (let i = 0; i < LOGIN_ATTEMPTS_PER_ACCOUNT; i += 1)
      await attempt('203.0.113.9', `guess-${i}`);
    expect(await attempt('203.0.113.9', 'victim-password')).toBe(429);
  });

  it('one address is throttled per account, not across accounts', async () => {
    const { attempt } = build();
    for (let i = 0; i < LOGIN_ATTEMPTS_PER_ACCOUNT; i += 1)
      await attempt('203.0.113.9', `guess-${i}`);
    expect(await attempt('203.0.113.9', 'x', 'someone-else@example.com')).toBe(401);
  });

  it('distributed guessing is still bounded per account across all addresses', async () => {
    const { attempt } = build();
    let evaluated = 0;
    for (let i = 0; i < LOGIN_ATTEMPTS_PER_ACCOUNT_ALL_CLIENTS + 30; i += 1) {
      // A new address for every attempt: the per-address budget never applies.
      if ((await attempt(`10.${Math.floor(i / 250)}.${i % 250}.7`, `guess-${i}`)) === 401)
        evaluated += 1;
    }
    expect(evaluated).toBe(LOGIN_ATTEMPTS_PER_ACCOUNT_ALL_CLIENTS);
  });

  it('unknown accounts are throttled the same way (no account oracle)', async () => {
    const { attempt } = build();
    const statuses: number[] = [];
    for (let i = 0; i < LOGIN_ATTEMPTS_PER_ACCOUNT + 1; i += 1) {
      statuses.push(await attempt('203.0.113.9', 'x', 'nobody@example.com'));
    }
    expect(statuses.at(-1)).toBe(429);
    expect(statuses.slice(0, -1).every((s) => s === 401)).toBe(true);
  });

  it('an IPv6 client cannot rotate addresses inside its /64 to escape the per-address budget', async () => {
    const { attempt } = build();
    const statuses: number[] = [];
    for (let i = 0; i < LOGIN_ATTEMPTS_PER_ACCOUNT + 5; i += 1) {
      statuses.push(
        await attempt(`2001:db8:abcd:12:${i.toString(16)}::${(i * 7).toString(16)}`, `guess-${i}`),
      );
    }
    expect(statuses.filter((s) => s === 401)).toHaveLength(LOGIN_ATTEMPTS_PER_ACCOUNT);
    // Another /64 (another subscriber) is unaffected.
    expect(await attempt('2001:db8:abcd:13::1', 'victim-password')).toBe(200);
  });
});
