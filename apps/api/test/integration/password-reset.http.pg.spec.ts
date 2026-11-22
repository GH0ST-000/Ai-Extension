/**
 * Password reset over real HTTP on PostgreSQL.
 *
 * Real: AuthController, AuthService (register/login/refresh), PasswordResetService,
 * RateLimitGuard (Redis replaced by an in-memory counter), ValidationPipe (main.ts options),
 * exception filter, PostgreSQL (migrations). Stubbed: email delivery (records messages;
 * never calls Resend).
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
import {
  hashResetToken,
  PASSWORD_RESET_REQUEST_MESSAGE,
  PasswordResetService,
  type ResetRequestOutcome,
} from '../../src/auth/password-reset.service';
import { RateLimitGuard } from '../../src/common/security/rate-limit.guard';
import { MailService, type MailMessage, type MailSendResult } from '../../src/mail/mail.service';
import { ObservabilityExceptionFilter } from '../../src/observability/observability-exception.filter';
import { RequestContextMiddleware } from '../../src/observability/request-context.middleware';
import { RequestContextService } from '../../src/observability/request-context.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { RedisService } from '../../src/redis/redis.service';
import { EmailVerificationService } from '../../src/auth/email-verification.service';

const URL_ENV = process.env.MEMORY_IT_DATABASE_URL;

const CONFIG: Record<string, unknown> = {
  nodeEnv: 'test',
  appBaseUrl: 'https://app.example.test',
  jwt: { secret: 'it-jwt-secret-0123456789abcdef', expiresIn: '15m', refreshExpiresIn: '7d' },
  mail: {
    enabled: true,
    resendApiKey: 're_test_key_never_used',
    from: 'Project X <no-reply@example.test>',
  },
};
function configGet(path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (value, part) =>
        value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined,
      CONFIG,
    );
}

describe.skipIf(!URL_ENV)('Password reset (PostgreSQL + HTTP)', () => {
  let prisma: PrismaClient;
  let app: INestApplication;
  let baseUrl: string;
  let resets: PasswordResetService;
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
  let processSpy: ReturnType<typeof vi.spyOn>;
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
    const redis = {
      status: 'ready',
      incr: async (key: string) => {
        const next = (counters.get(key) ?? 0) + 1;
        counters.set(key, next);
        return next;
      },
      expire: async () => 1,
    };
    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: config },
        {
          provide: JwtService,
          useValue: new JwtService({ secret: 'it-jwt-secret-0123456789abcdef' }),
        },
        { provide: RedisService, useValue: redis },
        { provide: MailService, useValue: mail },
        AuthService,
        PasswordResetService,
        EmailVerificationService,
        RateLimitGuard,
      ],
    }).compile();
    resets = moduleRef.get(PasswordResetService);
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
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
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
    sent.length = 0;
    mailResult = { delivered: true, providerId: 'msg_1' };
    mail.send.mockClear();
    logged.length = 0;
    processSpy = vi.spyOn(resets, 'processResetRequest');
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      vi.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logged.push(JSON.stringify(args));
      });
    }
  });

  afterEach(async () => {
    // Let every background reset finish inside its own test (no stray emails in the next one).
    await Promise.allSettled(processSpy.mock.results.map((r) => r.value as Promise<unknown>));
    vi.restoreAllMocks();
  });

  // ── helpers ──────────────────────────────────────────────────────────────

  async function call(path: string, body: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${baseUrl}/api${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-project-x-client': 'extension',
        ...headers,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return {
      status: res.status,
      body: (text ? JSON.parse(text) : {}) as Record<string, unknown>,
      setCookie: res.headers.get('set-cookie'),
    };
  }

  async function newUser(password = 'old-password-123') {
    run += 1;
    const email = `reset_${run}_${Date.now()}@it.test`;
    const res = await call('/auth/register', { email, password, name: 'Reset <User>' });
    expect(res.status).toBe(201);
    counters.clear();
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    return { email, password, user, refreshToken: res.body.refreshToken as string };
  }

  /** Request a reset and wait for its background processing. */
  async function requestReset(
    email: string,
  ): Promise<{ status: number; body: Record<string, unknown>; outcome: ResetRequestOutcome }> {
    const before = processSpy.mock.results.length;
    const res = await call('/auth/password-reset/request', { email });
    let outcome: ResetRequestOutcome = 'no_account';
    if (processSpy.mock.results.length > before) {
      outcome = (await processSpy.mock.results[processSpy.mock.results.length - 1]!
        .value) as ResetRequestOutcome;
    }
    return { ...res, outcome };
  }

  /** Newest reset email sent to this address (other tests' messages are ignored). */
  /** Password-reset emails only (registration also sends a verification email, Decision A). */
  const resetMails = () => sent.filter((m) => m.template === 'password_reset');

  function mailTo(email: string, nth = -1): MailMessage {
    const mine = resetMails().filter((m) => m.to === email.toLowerCase());
    const message = mine.at(nth);
    expect(message, `no email to ${email}`).toBeDefined();
    return message!;
  }

  function tokenFrom(message: MailMessage): string {
    const match = /#token=([A-Za-z0-9_-]{43})/.exec(message.text);
    expect(match).not.toBeNull();
    return match![1]!;
  }

  const confirm = (token: string, newPassword = 'new-password-456') =>
    call('/auth/password-reset/confirm', { token, newPassword });

  // ── request ──────────────────────────────────────────────────────────────

  it('known and unknown emails get the identical response; only the account owner is emailed', async () => {
    const { email, user } = await newUser();
    const known = await requestReset(email.toUpperCase()); // normalized like registration
    const unknown = await requestReset(`nobody_${Date.now()}@it.test`);
    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(known.body).toEqual(unknown.body);
    expect(known.body).toEqual({ ok: true, message: PASSWORD_RESET_REQUEST_MESSAGE });
    expect(known.outcome).toBe('sent');
    expect(unknown.outcome).toBe('no_account');
    expect(resetMails()).toHaveLength(1);
    expect(resetMails()[0]!.to).toBe(email);
    expect(resetMails()[0]!.text).toContain('https://app.example.test/reset-password#token=');
    // HTML escapes the user-controlled name.
    // Adversarial review N2: the registrant-chosen name is never echoed in the mail.
    expect(resetMails()[0]!.html).not.toContain('Reset &lt;User&gt;');
    expect(resetMails()[0]!.html).not.toContain('Reset <User>');
    expect(resetMails()[0]!.text).not.toContain('Reset <User>');
    // Only the hash is stored.
    const token = tokenFrom(mailTo(email));
    const rows = await prisma.passwordResetToken.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(hashResetToken(token));
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(rows[0]!.expiresAt.getTime() - rows[0]!.createdAt.getTime()).toBeGreaterThan(
      29 * 60_000,
    );
    expect(rows[0]!.expiresAt.getTime() - rows[0]!.createdAt.getTime()).toBeLessThanOrEqual(
      30 * 60_000 + 1_000,
    );
  });

  it('invalid email input is a validation error regardless of any account', async () => {
    for (const email of ['not-an-email', '', 'a@b', `${'x'.repeat(260)}@it.test`]) {
      expect((await call('/auth/password-reset/request', { email })).status, email).toBe(400);
    }
    expect((await call('/auth/password-reset/request', { email: 'a@b.co', extra: 1 })).status).toBe(
      400,
    );
  });

  it('a request does not touch existing sessions', async () => {
    const { email, user, refreshToken } = await newUser();
    await requestReset(email);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.sessionVersion).toBe(user.sessionVersion);
    expect(await prisma.refreshToken.count({ where: { userId: user.id, revokedAt: null } })).toBe(
      1,
    );
    expect((await call('/auth/refresh', { refreshToken })).status).toBe(200);
  });

  it('repeated requests: a cooldown, only the newest link works, and an hourly cap', async () => {
    const { email, user } = await newUser();
    await requestReset(email);
    const first = tokenFrom(mailTo(email, 0));
    // Within the cooldown: same response, no new email, first link still valid.
    const again = await requestReset(email);
    expect(again.status).toBe(202);
    expect(again.outcome).toBe('throttled');
    expect(resetMails()).toHaveLength(1);
    // After the cooldown: a new link; the older one stops working.
    await prisma.passwordResetToken.updateMany({
      where: { userId: user.id },
      data: { createdAt: new Date(Date.now() - 2 * 60_000) },
    });
    counters.clear();
    await requestReset(email);
    expect(resetMails()).toHaveLength(2);
    const second = tokenFrom(mailTo(email));
    expect((await confirm(first)).status).toBe(400);
    // Hourly cap: at most 5 tokens per hour (backdate to pass the cooldown each time).
    for (let i = 0; i < 6; i += 1) {
      await prisma.passwordResetToken.updateMany({
        where: { userId: user.id },
        data: { createdAt: new Date(Date.now() - 2 * 60_000) },
      });
      counters.clear();
      await requestReset(email);
    }
    expect(await prisma.passwordResetToken.count({ where: { userId: user.id } })).toBe(5);
    expect(
      await prisma.passwordResetToken.count({ where: { userId: user.id, usedAt: null } }),
    ).toBe(1);
    expect(second).not.toBe(first);
  });

  it('email provider outage: same response, no live token left behind, nothing sensitive logged', async () => {
    const { email, user } = await newUser();
    mailResult = { delivered: false, reason: 'provider_rejected' };
    const res = await requestReset(email);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true, message: PASSWORD_RESET_REQUEST_MESSAGE });
    expect(res.outcome).toBe('mail_failed');
    expect(
      await prisma.passwordResetToken.count({ where: { userId: user.id, usedAt: null } }),
    ).toBe(0);
    const token = tokenFrom(mailTo(email));
    expect(logged.join('\n')).not.toContain(token);
    expect(logged.join('\n')).not.toContain('reset-password#');
  });

  it('rate limit applies the same way to known and unknown emails', async () => {
    const { email } = await newUser();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      statuses.push(
        (await call('/auth/password-reset/request', { email: i % 2 ? email : `x${i}@it.test` }))
          .status,
      );
    }
    expect(statuses).toEqual([202, 202, 202, 202, 202, 429]);
  });

  // ── confirm ──────────────────────────────────────────────────────────────

  it('confirmation sets the new password and signs out everywhere, without signing in', async () => {
    const { email, password, user, refreshToken } = await newUser();
    const second = await call('/auth/login', { email, password });
    expect(second.status).toBe(200);
    await requestReset(email);
    const token = tokenFrom(mailTo(email));

    const res = await confirm(token, 'brand-new-password-1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.setCookie).toBeNull(); // no session issued
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.sessionVersion).toBe(user.sessionVersion + 1); // access tokens invalid
    expect(await prisma.refreshToken.count({ where: { userId: user.id, revokedAt: null } })).toBe(
      0,
    );
    expect((await call('/auth/refresh', { refreshToken })).status).toBe(401);
    expect((await call('/auth/login', { email, password })).status).toBe(401);
    expect((await call('/auth/login', { email, password: 'brand-new-password-1' })).status).toBe(
      200,
    );
    // Single use.
    expect((await confirm(token, 'another-password-2')).status).toBe(400);
  });

  it('invalid, expired and used tokens fail identically; weak passwords are rejected', async () => {
    const { email, user } = await newUser();
    await requestReset(email);
    const token = tokenFrom(mailTo(email));
    expect((await confirm(token, 'short')).status).toBe(400); // registration rules
    expect((await confirm(token, 'x'.repeat(129))).status).toBe(400);

    const malformed = await confirm('not-a-real-token-but-long-enough');
    const unknown = await confirm('A'.repeat(43));
    await prisma.passwordResetToken.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    const expired = await confirm(token);
    for (const res of [malformed, unknown, expired]) {
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('PASSWORD_RESET_INVALID');
      expect(res.body.message).toBe(unknown.body.message);
    }
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.passwordHash).toBe(user.passwordHash);
  });

  it('two simultaneous confirmations with one token: exactly one succeeds', async () => {
    const { email, user } = await newUser();
    await requestReset(email);
    const token = tokenFrom(mailTo(email));
    const results = await Promise.all([
      confirm(token, 'racer-password-aaa'),
      confirm(token, 'racer-password-bbb'),
      confirm(token, 'racer-password-ccc'),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400, 400]);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.sessionVersion).toBe(user.sessionVersion + 1); // applied once
  });

  it('a reset never affects another account', async () => {
    const a = await newUser();
    const b = await newUser();
    await requestReset(a.email);
    const token = tokenFrom(mailTo(a.email));
    expect((await confirm(token, 'a-new-password-123')).status).toBe(200);
    const bAfter = await prisma.user.findUniqueOrThrow({ where: { id: b.user.id } });
    expect(bAfter.passwordHash).toBe(b.user.passwordHash);
    expect(bAfter.sessionVersion).toBe(b.user.sessionVersion);
    expect(await prisma.refreshToken.count({ where: { userId: b.user.id, revokedAt: null } })).toBe(
      1,
    );
    expect((await call('/auth/login', { email: b.email, password: b.password })).status).toBe(200);
  });

  it('no token or reset link ever appears in logs', async () => {
    const { email } = await newUser();
    await requestReset(email);
    const token = tokenFrom(mailTo(email));
    await confirm(token, 'logged-password-1');
    await confirm(token, 'logged-password-2');
    const all = logged.join('\n');
    expect(all).not.toContain(token);
    expect(all).not.toContain(hashResetToken(token));
    expect(all).not.toContain('reset-password#');
    expect(all).not.toContain('logged-password');
  });
});
