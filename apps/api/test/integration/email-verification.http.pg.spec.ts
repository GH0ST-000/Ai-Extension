/**
 * Decision A — email ownership verification (PostgreSQL + HTTP).
 *
 * Real: AuthController (register, verification status / resend / confirm), AuthService,
 * EmailVerificationService, JwtStrategy + JwtAuthGuard, rate-limit guard, ValidationPipe,
 * RequestContext middleware, exception filter, PostgreSQL.
 * Stubbed: the mail provider (messages captured; nothing is sent), Redis (in-memory counters).
 */
import { type INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthController } from '../../src/auth/auth.controller';
import { AuthService } from '../../src/auth/auth.service';
import { personalWorkspaceSlug } from '@project-x/shared';
import {
  EmailVerificationService,
  hashVerificationToken,
} from '../../src/auth/email-verification.service';
import { JwtStrategy } from '../../src/auth/jwt.strategy';
import { PasswordResetService } from '../../src/auth/password-reset.service';
import { RateLimitGuard } from '../../src/common/security/rate-limit.guard';
import { resetLocalRateLimitsForTests } from '../../src/common/security/rate-limiter';
import { MailService, type MailMessage, type MailSendResult } from '../../src/mail/mail.service';
import { ObservabilityExceptionFilter } from '../../src/observability/observability-exception.filter';
import { RequestContextMiddleware } from '../../src/observability/request-context.middleware';
import { RequestContextService } from '../../src/observability/request-context.service';
import { scrubSentryEvent } from '../../src/observability/sentry-error-tracker';
import { PrismaService } from '../../src/prisma/prisma.service';
import { RedisService } from '../../src/redis/redis.service';

const URL_ENV = process.env.MEMORY_IT_DATABASE_URL;
const JWT_SECRET = 'it-jwt-secret-0123456789abcdef';
const CONFIG: Record<string, unknown> = {
  nodeEnv: 'test',
  appBaseUrl: 'https://app.example.test',
  jwt: { secret: JWT_SECRET, expiresIn: '15m', refreshExpiresIn: '7d' },
  ai: { corsOrigins: [] },
  mail: { enabled: true, resendApiKey: 're_test_never_used', from: 'X <no-reply@example.test>' },
};
const configGet = (path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>(
      (v, part) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[part] : undefined),
      CONFIG,
    );

describe.skipIf(!URL_ENV)('Email verification (PostgreSQL + HTTP)', () => {
  let prisma: PrismaClient;
  let app: INestApplication;
  let baseUrl: string;
  let verification: EmailVerificationService;
  const counters = new Map<string, number>();
  const sent: MailMessage[] = [];
  let mailResult: MailSendResult = { delivered: true, providerId: 'msg_1' };
  const mail = {
    isEnabled: () => true,
    send: vi.fn(async (message: MailMessage) => {
      sent.push(message);
      return mailResult;
    }),
  };
  const logged: string[] = [];
  let run = 0;

  beforeAll(async () => {
    const url = new URL(URL_ENV!);
    if (!url.pathname.endsWith('_it') || url.port === '5432') {
      throw new Error(`Refusing to run integration tests against ${url.host}${url.pathname}`);
    }
    prisma = new PrismaClient({ datasourceUrl: URL_ENV });
    await prisma.$connect();
    const config = { get: (path: string) => configGet(path) };
    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: config },
        { provide: JwtService, useValue: new JwtService({ secret: JWT_SECRET }) },
        {
          provide: RedisService,
          useValue: {
            status: 'ready',
            incr: async (key: string) => {
              const next = (counters.get(key) ?? 0) + 1;
              counters.set(key, next);
              return next;
            },
            expire: async () => 1,
          },
        },
        { provide: MailService, useValue: mail },
        AuthService,
        PasswordResetService,
        EmailVerificationService,
        JwtStrategy,
        RateLimitGuard,
      ],
    }).compile();
    verification = moduleRef.get(EmailVerificationService);
    app = moduleRef.createNestApplication({ logger: false });
    const requestContext = new RequestContextService();
    const middleware = new RequestContextMiddleware(
      requestContext,
      { shouldSample: () => false } as never,
      { get: () => undefined } as never,
    );
    app.use((req: Request, res: Response, next: NextFunction) => middleware.use(req, res, next));
    app.useGlobalFilters(new ObservabilityExceptionFilter(requestContext));
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  beforeEach(() => {
    counters.clear();
    resetLocalRateLimitsForTests();
    sent.length = 0;
    mailResult = { delivered: true, providerId: 'msg_1' };
    mail.send.mockClear();
    logged.length = 0;
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logged.push(JSON.stringify(args));
      });
    }
  });
  afterEach(() => vi.restoreAllMocks());

  // ── helpers ──────────────────────────────────────────────────────────────

  async function http(method: string, path: string, body?: unknown, token?: string) {
    const res = await fetch(`${baseUrl}/api${path}`, {
      method,
      headers: {
        'x-project-x-client': 'extension',
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
  }

  /** Registers and waits for the background verification email. */
  async function register() {
    run += 1;
    const email = `ev_${run}_${Date.now()}@it.test`;
    const res = await http('POST', '/auth/register', {
      email,
      password: 'correct-horse-battery-9',
      name: 'Eve',
    });
    expect(res.status).toBe(201);
    const userId = (res.body.user as { id: string }).id;
    for (let i = 0; i < 100 && !sent.some((m) => m.to === email); i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    return { email, userId, accessToken: res.body.accessToken as string };
  }
  const tokenFrom = (message: MailMessage) => {
    const match = /\/verify-email#token=([A-Za-z0-9_-]{43})/.exec(message.text);
    expect(match).not.toBeNull();
    return match![1]!;
  };
  /** F-05: confirming needs the token AND a session of the account it was issued for. */
  const confirm = (token: string, accessToken?: string) =>
    http('POST', '/auth/email-verification/confirm', { token }, accessToken);
  const verifiedAt = async (userId: string) =>
    (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).emailVerifiedAt;

  // ── lifecycle ────────────────────────────────────────────────────────────

  it('register sends a single-use link; confirming verifies; reuse is refused', async () => {
    const { email, userId, accessToken } = await register();
    const message = sent.find((m) => m.to === email)!;
    expect(message.template).toBe('email_verification');
    const token = tokenFrom(message);
    // Only the hash is stored.
    const stored = await prisma.emailVerificationToken.findFirstOrThrow({ where: { userId } });
    expect(stored.tokenHash).toBe(hashVerificationToken(token));
    expect(JSON.stringify(stored)).not.toContain(token);

    expect((await http('GET', '/auth/email-verification', undefined, accessToken)).body).toEqual({
      email,
      verified: false,
    });
    expect((await confirm(token, accessToken)).status).toBe(200);
    expect(await verifiedAt(userId)).not.toBeNull();
    const reused = await confirm(token, accessToken);
    expect(reused.status).toBe(400);
    expect(reused.body.code).toBe('EMAIL_VERIFICATION_INVALID');
    expect(
      (await http('GET', '/auth/email-verification', undefined, accessToken)).body,
    ).toMatchObject({
      verified: true,
    });
  });

  // ── F-05: the link alone must not verify someone else's account ─────────

  it('[F-05] victim-click: an unauthenticated confirmation is refused and changes nothing', async () => {
    // The attacker registers the victim's address and keeps the session (accessToken); the
    // victim receives the mail and opens the link in a browser that has no session.
    const { email, userId, accessToken: attackerSession } = await register();
    const token = tokenFrom(sent.find((m) => m.to === email)!);

    const victimClick = await confirm(token);
    expect(victimClick.status).toBe(401);
    expect(await verifiedAt(userId)).toBeNull();
    // Not consumed: nothing happened at all.
    expect(await prisma.emailVerificationToken.count({ where: { userId, usedAt: null } })).toBe(1);
    // The attacker's session is still just an unverified account.
    expect(
      (await http('GET', '/auth/email-verification', undefined, attackerSession)).body,
    ).toEqual({ email, verified: false });
  });

  it('[F-05] a session of ANOTHER account cannot confirm the link (and does not burn it)', async () => {
    const owner = await register();
    const token = tokenFrom(sent.find((m) => m.to === owner.email)!);
    const other = await register();

    const wrong = await confirm(token, other.accessToken);
    expect(wrong.status).toBe(403);
    expect(wrong.body.code).toBe('EMAIL_VERIFICATION_WRONG_ACCOUNT');
    expect(JSON.stringify(wrong.body)).not.toContain(owner.email);
    expect(await verifiedAt(owner.userId)).toBeNull();
    expect(await verifiedAt(other.userId)).toBeNull();

    // The rightful account can still use the same link.
    expect((await confirm(token, owner.accessToken)).status).toBe(200);
    expect(await verifiedAt(owner.userId)).not.toBeNull();
    expect(await verifiedAt(other.userId)).toBeNull();
  });

  it('[F-05] after a password reset the previous holder of the account can no longer confirm', async () => {
    // Attacker pre-registers; the real owner takes the account over through "forgot password"
    // (which bumps the session version): the attacker's old session is dead for confirmation.
    const { email, userId, accessToken: attackerSession } = await register();
    const token = tokenFrom(sent.find((m) => m.to === email)!);
    await prisma.user.update({ where: { id: userId }, data: { sessionVersion: { increment: 1 } } });
    expect((await confirm(token, attackerSession)).status).toBe(401);
    expect(await verifiedAt(userId)).toBeNull();
  });

  it('invalid and malformed tokens are refused without changing anything', async () => {
    const { userId, accessToken } = await register();
    const random = 'A'.repeat(43);
    expect((await confirm(random, accessToken)).body.code).toBe('EMAIL_VERIFICATION_INVALID');
    expect((await confirm('short', accessToken)).status).toBe(400);
    expect(await verifiedAt(userId)).toBeNull();
  });

  it('an expired token is refused as expired and can be replaced', async () => {
    const { email, userId, accessToken } = await register();
    const token = tokenFrom(sent.find((m) => m.to === email)!);
    await prisma.emailVerificationToken.updateMany({
      where: { userId },
      data: {
        expiresAt: new Date(Date.now() - 1000),
        createdAt: new Date(Date.now() - 3 * 60_000),
      },
    });
    const expired = await confirm(token, accessToken);
    expect(expired.body.code).toBe('EMAIL_VERIFICATION_EXPIRED');
    expect(await verifiedAt(userId)).toBeNull();
    // Resend issues a fresh link (the old one stays dead).
    const resent = await http('POST', '/auth/email-verification/resend', undefined, accessToken);
    expect(resent.status).toBe(202);
    expect(resent.body.status).toBe('sent');
    const fresh = tokenFrom(sent.filter((m) => m.to === email).at(-1)!);
    expect(fresh).not.toBe(token);
    expect((await confirm(fresh, accessToken)).status).toBe(200);
    expect((await confirm(token, accessToken)).status).toBe(400);
  });

  it('concurrent confirmations of one token: exactly one succeeds', async () => {
    const { email, userId, accessToken } = await register();
    const token = tokenFrom(sent.find((m) => m.to === email)!);
    const results = await Promise.all(Array.from({ length: 6 }, () => confirm(token, accessToken)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await verifiedAt(userId)).not.toBeNull();
  });

  it('resend is throttled (cooldown, then hourly cap) and refuses already-verified accounts', async () => {
    const { userId, accessToken } = await register();
    // Right after registration: cooldown.
    expect(
      (await http('POST', '/auth/email-verification/resend', undefined, accessToken)).body.status,
    ).toBe('throttled');
    // Simulate four more links spread over the hour → hourly cap reached.
    for (let i = 0; i < 4; i += 1) {
      await prisma.emailVerificationToken.create({
        data: {
          userId,
          email: 'x@it.test',
          tokenHash: `h_${userId}_${i}`,
          expiresAt: new Date(Date.now() + 1000),
          createdAt: new Date(Date.now() - (10 + i) * 60_000),
        },
      });
    }
    await prisma.emailVerificationToken.updateMany({
      where: { userId },
      data: { createdAt: new Date(Date.now() - 5 * 60_000) },
    });
    expect(await verification.issue(userId)).toBe('throttled');
    await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
    expect(await verification.issue(userId)).toBe('already_verified');
  });

  it('undelivered mail never leaves a live token; the link is bound to the address it was sent to', async () => {
    const { email, userId, accessToken } = await register();
    mailResult = { delivered: false, reason: 'not_configured' };
    await prisma.emailVerificationToken.updateMany({
      where: { userId },
      data: { createdAt: new Date(Date.now() - 2 * 60_000) },
    });
    expect(await verification.issue(userId)).toBe('mail_not_configured');
    expect(await prisma.emailVerificationToken.count({ where: { userId, usedAt: null } })).toBe(0);

    // A token sent to the old address does not verify a different (changed) address.
    mailResult = { delivered: true, providerId: 'm' };
    await prisma.emailVerificationToken.updateMany({
      where: { userId },
      data: { createdAt: new Date(Date.now() - 2 * 60_000) },
    });
    expect(await verification.issue(userId)).toBe('sent');
    const token = tokenFrom(sent.filter((m) => m.to === email).at(-1)!);
    await prisma.user.update({ where: { id: userId }, data: { email: `changed_${email}` } });
    expect((await confirm(token, accessToken)).status).toBe(400);
    expect(await verifiedAt(userId)).toBeNull();
  });

  it('legacy accounts (created before verification existed) stay unverified — never auto-verified', async () => {
    run += 1;
    const id = `legacy_${run}_${Date.now()}`;
    await prisma.user.create({ data: { id, email: `${id}@it.test`, passwordHash: 'x' } });
    expect(await verifiedAt(id)).toBeNull();
    expect(await verification.status(id)).toEqual({ email: `${id}@it.test`, verified: false });
  });

  it('tokens never reach logs, response bodies or Sentry events', async () => {
    const { email, accessToken } = await register();
    const token = tokenFrom(sent.find((m) => m.to === email)!);
    const confirmed = await confirm(token, accessToken);
    expect(JSON.stringify(confirmed.body)).not.toContain(token);
    expect(logged.join('\n')).not.toContain(token);
    // A Sentry event of the confirm request: the JSON body (carrying the token) is dropped.
    const event = scrubSentryEvent({
      request: {
        url: 'https://api.example.test/api/auth/email-verification/confirm',
        data: { token },
      },
    });
    expect(JSON.stringify(event)).not.toContain(token);
  });

  // ── Decision 2: delivery failures ─────────────────────────────────────────────────────────

  it.each(['timeout', 'provider_rejected', 'network'] as const)(
    'registration succeeds when delivery fails (%s): token revoked, failure observable, nothing leaked',
    async (reason) => {
      mailResult = { delivered: false, reason };
      const { email, userId, accessToken } = await register();
      for (let i = 0; i < 100 && !logged.some((l) => l.includes('delivery_failed')); i += 1) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(accessToken).toBeTruthy(); // registration contract unchanged (201 + session)
      expect(mail.send).toHaveBeenCalledTimes(1); // exactly one attempt, no automatic retry storm
      expect(await prisma.emailVerificationToken.count({ where: { userId } })).toBe(1);
      expect(await prisma.emailVerificationToken.count({ where: { userId, usedAt: null } })).toBe(
        0,
      );
      const failure = logged.find((l) => l.includes('email_verification.delivery_failed'))!;
      expect(failure).toContain(reason);
      expect(failure).not.toContain(email);
      const token = tokenFrom(sent.find((m) => m.to === email)!);
      expect(logged.join('\n')).not.toContain(token);
      expect(logged.join('\n')).not.toContain('re_test_never_used');
      // The revoked link does not verify.
      expect((await confirm(token, accessToken)).status).toBe(400);
      expect(await verifiedAt(userId)).toBeNull();
    },
  );

  it('resend reports a failed delivery accurately; a later resend succeeds and only that link works', async () => {
    const { email, userId, accessToken } = await register();
    const firstToken = tokenFrom(sent.find((m) => m.to === email)!);
    const age = () =>
      prisma.emailVerificationToken.updateMany({
        where: { userId },
        data: { createdAt: new Date(Date.now() - 2 * 60_000) },
      });
    await age();
    mailResult = { delivered: false, reason: 'timeout' };
    const failed = await http('POST', '/auth/email-verification/resend', {}, accessToken);
    expect(failed).toEqual({ status: 202, body: { status: 'mail_failed' } });
    // The failed attempt counts toward the cooldown: an immediate retry is throttled, not re-sent.
    mailResult = { delivered: true, providerId: 'm2' };
    const sendsBefore = mail.send.mock.calls.length;
    expect((await http('POST', '/auth/email-verification/resend', {}, accessToken)).body).toEqual({
      status: 'throttled',
    });
    expect(mail.send.mock.calls.length).toBe(sendsBefore);
    await age();
    expect((await http('POST', '/auth/email-verification/resend', {}, accessToken)).body).toEqual({
      status: 'sent',
    });
    const latest = tokenFrom(sent.filter((m) => m.to === email).at(-1)!);
    expect((await confirm(firstToken, accessToken)).status).toBe(400);
    expect((await confirm(latest, accessToken)).status).toBe(200);
    expect(await verifiedAt(userId)).not.toBeNull();
    // Single use after success.
    expect((await confirm(latest, accessToken)).status).toBe(400);
  });

  it('the verification URL is the configured https origin + /verify-email with the token only in the fragment', async () => {
    const { email } = await register();
    const message = sent.find((m) => m.to === email)!;
    const link = /https:\/\/\S+verify-email#token=[A-Za-z0-9_-]{43}/.exec(message.text)![0];
    const parsed = new URL(link);
    expect(parsed.origin).toBe('https://app.example.test');
    expect(parsed.pathname).toBe('/verify-email');
    expect(parsed.search).toBe(''); // never in the query (server logs, Referer)
    expect(parsed.hash).toMatch(/^#token=/);
    expect(message.html).toContain(link.replace(/&/g, '&amp;'));
  });

  // ── registration races (root cause of the intermittent registration 500) ─────────────────

  it('concurrent registrations of the same email: one 201, the rest the generic 409 — never 500', async () => {
    run += 1;
    const email = `race_${run}_${Date.now()}@it.test`;
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        http('POST', '/auth/register', { email, password: 'correct-horse-battery-9' }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status !== 201).every((r) => r.status === 409)).toBe(true);
    expect(await prisma.user.count({ where: { email } })).toBe(1);
  });

  it('a personal-workspace slug taken by a concurrent, not-yet-visible registration is retried, not a 500', async () => {
    // Deterministic reproduction: the slug derives from the first 16 characters of the user id,
    // which two processes can share (same millisecond, counter and fingerprint prefix). Here a
    // "concurrent" committed workspace takes the slug right after the user row is created,
    // while the in-transaction availability check cannot see it (as with an uncommitted row).
    let collide = true;
    const racing = new Proxy(prisma, {
      get(target, prop, receiver) {
        if (prop !== '$transaction') return Reflect.get(target, prop, receiver);
        return (fn: (tx: unknown) => Promise<unknown>, options?: unknown) =>
          target.$transaction(
            (tx) =>
              fn(
                new Proxy(tx, {
                  get(t, key, r) {
                    if (key === 'user' && collide) {
                      return new Proxy(t.user, {
                        get(u, k, r2) {
                          if (k !== 'create') return Reflect.get(u, k, r2);
                          return async (args: never) => {
                            const created = (await t.user.create(args)) as { id: string };
                            await prisma.workspace.create({
                              data: {
                                id: `ws_squatter_${created.id}`,
                                name: 'squatter',
                                slug: personalWorkspaceSlug(created.id),
                              },
                            });
                            return created;
                          };
                        },
                      });
                    }
                    if (key === 'workspace' && collide) {
                      return new Proxy(t.workspace, {
                        get(w, k, r3) {
                          if (k !== 'findUnique') return Reflect.get(w, k, r3);
                          return async () => {
                            collide = false; // invisible once, like an uncommitted insert
                            return null;
                          };
                        },
                      });
                    }
                    return Reflect.get(t, key, r);
                  },
                }),
              ),
            options as never,
          );
      },
    });
    const service = new AuthService(racing as never, new JwtService({ secret: JWT_SECRET }), {
      get: (path: string) => configGet(path),
    } as never);
    run += 1;
    const email = `slug_${run}_${Date.now()}@it.test`;
    const result = await service.register({ email, password: 'correct-horse-battery-9' } as never);
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(result.user.id).toBe(user.id);
    const personal = await prisma.workspace.findUniqueOrThrow({ where: { id: `ws_${user.id}` } });
    expect(personal.slug).not.toBe(personalWorkspaceSlug(user.id)); // retried with a new slug
    expect(personal.slug.startsWith(personalWorkspaceSlug(user.id))).toBe(true);
    expect(await prisma.user.count({ where: { email } })).toBe(1); // first attempt rolled back
  });
});
