/**
 * M2 — login CSRF. Real AuthController/AuthService over HTTP with production body parsing
 * (`applyBodyParsers`, no form-encoded parser) and production-style trusted origins.
 * PostgreSQL is the disposable integration database; mail is stubbed (nothing is sent).
 */
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';

import { PrismaClient } from '@prisma/client';
import cookieParser from 'cookie-parser';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthController } from '../../src/auth/auth.controller';
import { AuthService } from '../../src/auth/auth.service';
import { PasswordResetService } from '../../src/auth/password-reset.service';
import { applyBodyParsers } from '../../src/common/http/body-parsers';
import { applyCookieCsrfProtection } from '../../src/common/security/cookie-csrf';
import { RateLimitGuard } from '../../src/common/security/rate-limit.guard';
import { MailService } from '../../src/mail/mail.service';
import { ObservabilityExceptionFilter } from '../../src/observability/observability-exception.filter';
import { RequestContextService } from '../../src/observability/request-context.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { RedisService } from '../../src/redis/redis.service';
import { EmailVerificationService } from '../../src/auth/email-verification.service';

const URL_ENV = process.env.MEMORY_IT_DATABASE_URL;
const DASHBOARD = 'https://app.example.test';
const EXTENSION = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

const CONFIG: Record<string, unknown> = {
  nodeEnv: 'production',
  appBaseUrl: DASHBOARD,
  ai: { corsOrigins: [DASHBOARD, EXTENSION], corsContentScriptOrigins: ['https://github.com'] },
  jwt: { secret: 'it-jwt-secret-0123456789abcdef', expiresIn: '15m', refreshExpiresIn: '7d' },
  mail: { enabled: false, resendApiKey: '', from: '' },
};
const configGet = (path: string): unknown =>
  path
    .split('.')
    .reduce<unknown>(
      (v, part) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[part] : undefined),
      CONFIG,
    );

describe.skipIf(!URL_ENV)('Authentication CSRF protection (PostgreSQL + HTTP)', () => {
  let prisma: PrismaClient;
  let app: NestExpressApplication;
  let base: string;
  const counters = new Map<string, number>();
  let run = 0;

  beforeAll(async () => {
    const url = new URL(URL_ENV!);
    if (!url.pathname.endsWith('_it') || url.port === '5432') {
      throw new Error(`Refusing to run integration tests against ${url.host}${url.pathname}`);
    }
    prisma = new PrismaClient({ datasourceUrl: URL_ENV });
    await prisma.$connect();
    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: (path: string) => configGet(path) } },
        {
          provide: JwtService,
          useValue: new JwtService({ secret: 'it-jwt-secret-0123456789abcdef' }),
        },
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
        { provide: MailService, useValue: { isEnabled: () => false, send: vi.fn() } },
        AuthService,
        PasswordResetService,
        EmailVerificationService,
        RateLimitGuard,
      ],
    }).compile();
    // Production body parsing: Nest defaults off (they include urlencoded), JSON only.
    app = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
      rawBody: true,
      logger: false,
    });
    applyBodyParsers(app, 1_000_000);
    app.use(cookieParser()); // as in main.ts
    // N-4: the global cookie-CSRF protection, as in main.ts (must not break the M2 flows).
    applyCookieCsrfProtection(app, {
      nodeEnv: 'production',
      configuredOrigins: [DASHBOARD, EXTENSION],
    });
    app.useGlobalFilters(new ObservabilityExceptionFilter(new RequestContextService()));
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  });
  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });
  beforeEach(() => counters.clear());

  async function send(
    path: string,
    init: { body?: string | Uint8Array; headers?: Record<string, string> } = {},
  ) {
    const res = await fetch(`${base}/api${path}`, {
      method: 'POST',
      headers: init.headers ?? {},
      ...(init.body !== undefined ? { body: init.body } : {}),
    });
    const text = await res.text();
    return {
      status: res.status,
      body: (text ? JSON.parse(text) : {}) as Record<string, unknown>,
      cookies: res.headers.getSetCookie(),
    };
  }
  const json = (body: unknown, headers: Record<string, string> = {}) => ({
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  });

  async function account() {
    run += 1;
    const email = `csrf_${run}_${Date.now()}@it.test`;
    const password = 'correct-horse-battery-9';
    const created = await send('/auth/register', json({ email, password }, { origin: DASHBOARD }));
    expect(created.status).toBe(201);
    return { email, password };
  }
  const cookie = (cookies: string[], name: string) =>
    cookies.find((c) => c.startsWith(`${name}=`))?.split(';')[0];

  // ── content type ─────────────────────────────────────────────────────────────────────────

  it('JSON login from the dashboard sets the session cookies', async () => {
    const { email, password } = await account();
    const r = await send('/auth/login', json({ email, password }, { origin: DASHBOARD }));
    expect(r.status).toBe(200);
    expect(cookie(r.cookies, 'px_at')).toBeTruthy();
    expect(cookie(r.cookies, 'px_rt')).toBeTruthy();
  });

  it('form-encoded, text/plain and multipart login are rejected with 415 and set no cookie', async () => {
    const { email, password } = await account();
    const form = `email=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}`;
    for (const [body, type] of [
      [form, 'application/x-www-form-urlencoded'],
      [JSON.stringify({ email, password }), 'text/plain'],
      ['--x\r\n\r\n--x--', 'multipart/form-data; boundary=x'],
    ] as const) {
      // Even from a trusted origin: the content type alone is refused.
      const r = await send('/auth/login', {
        body,
        headers: { 'content-type': type, origin: DASHBOARD },
      });
      expect(r.status).toBe(415);
      expect(r.body.code).toBe('AUTH_JSON_REQUIRED');
      expect(r.cookies).toEqual([]);
    }
  });

  it('a body without a Content-Type is rejected; JSON with a charset is accepted', async () => {
    const { email, password } = await account();
    const raw = new TextEncoder().encode(JSON.stringify({ email, password }));
    const missing = await send('/auth/login', { body: raw, headers: { origin: DASHBOARD } });
    expect(missing.status).toBe(415);
    const charset = await send('/auth/login', {
      body: JSON.stringify({ email, password }),
      headers: { 'content-type': 'application/json; charset=utf-8', origin: DASHBOARD },
    });
    expect(charset.status).toBe(200);
  });

  // ── origin ───────────────────────────────────────────────────────────────────────────────

  it('untrusted, null and content-script origins are rejected with 403 and set no cookie', async () => {
    const { email, password } = await account();
    for (const origin of [
      'https://evil.example',
      'null',
      'https://github.com',
      'https://app.example.test.evil.example',
    ]) {
      const r = await send('/auth/login', json({ email, password }, { origin }));
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('AUTH_ORIGIN_FORBIDDEN');
      expect(r.cookies).toEqual([]);
    }
  });

  it('a cross-site HTML form login (what a malicious page can send) never succeeds', async () => {
    const { email, password } = await account();
    const r = await send('/auth/login', {
      body: `email=${encodeURIComponent(email)}&password=${encodeURIComponent(password)}`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://evil.example',
        'sec-fetch-site': 'cross-site',
      },
    });
    expect(r.status).toBe(415);
    expect(r.cookies).toEqual([]);
    // Without an Origin, a browser-labelled cross-site request is still refused.
    const noOrigin = await send(
      '/auth/login',
      json({ email, password }, { 'sec-fetch-site': 'cross-site' }),
    );
    expect(noOrigin.status).toBe(403);
  });

  // ── preserved flows ──────────────────────────────────────────────────────────────────────

  it('extension: login from its page origin or its service worker (no Origin) returns tokens', async () => {
    const { email, password } = await account();
    for (const headers of [{ origin: EXTENSION }, {}]) {
      const r = await send(
        '/auth/login',
        json({ email, password }, { 'x-project-x-client': 'extension', ...headers }),
      );
      expect(r.status).toBe(200);
      expect(typeof r.body.accessToken).toBe('string');
      expect(typeof r.body.refreshToken).toBe('string');
    }
  });

  it('refresh: cookie refresh without a body rotates; reusing the old token is still detected', async () => {
    const { email, password } = await account();
    const login = await send('/auth/login', json({ email, password }, { origin: DASHBOARD }));
    const rt = cookie(login.cookies, 'px_rt')!;
    const rotated = await send('/auth/refresh', { headers: { origin: DASHBOARD, cookie: rt } });
    expect(rotated.status).toBe(200);
    expect(cookie(rotated.cookies, 'px_rt')).not.toBe(rt);
    // Dashboard style (JSON "{}" body) also works.
    const next = cookie(rotated.cookies, 'px_rt')!;
    const again = await send('/auth/refresh', json({}, { origin: DASHBOARD, cookie: next }));
    expect(again.status).toBe(200);
    // The login's token family (registration created another one), found by the stored hash.
    const rawRt = decodeURIComponent(rt.slice(rt.indexOf('=') + 1));
    const dashboardFamily = (
      await prisma.refreshToken.findUniqueOrThrow({
        where: { tokenHash: createHash('sha256').update(rawRt).digest('hex') },
        select: { familyId: true },
      })
    ).familyId;
    // Extension style: refresh token in a JSON body.
    const ext = await send(
      '/auth/login',
      json({ email, password }, { 'x-project-x-client': 'extension' }),
    );
    const extRefresh = await send(
      '/auth/refresh',
      json({ refreshToken: ext.body.refreshToken }, { 'x-project-x-client': 'extension' }),
    );
    expect(extRefresh.status).toBe(200);
    // Reuse of an already-rotated token outside the grace window is still detected: the
    // token family is revoked and every session of the user is invalidated.
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    await prisma.refreshToken.updateMany({
      where: { userId: user.id, replacedByTokenId: { not: null } },
      data: { revokedAt: new Date(Date.now() - 60 * 60 * 1000) },
    });
    const reuse = await send('/auth/refresh', { headers: { origin: DASHBOARD, cookie: rt } });
    expect(reuse.status).toBe(401);
    const afterReuse = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(afterReuse.sessionVersion).toBeGreaterThan(user.sessionVersion);
    // The reused token's family is revoked (other families die via the sessionVersion bump).
    expect(
      await prisma.refreshToken.count({ where: { familyId: dashboardFamily, revokedAt: null } }),
    ).toBe(0);
  });

  it('N-14: concurrent refreshes with the same token mint exactly ONE new token', async () => {
    const { email, password } = await account();
    const login = await send('/auth/login', json({ email, password }, { origin: DASHBOARD }));
    const rt = cookie(login.cookies, 'px_rt')!;
    const rawRt = decodeURIComponent(rt.slice(rt.indexOf('=') + 1));
    const family = (
      await prisma.refreshToken.findUniqueOrThrow({
        where: { tokenHash: createHash('sha256').update(rawRt).digest('hex') },
        select: { familyId: true },
      })
    ).familyId;
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        send('/auth/refresh', { headers: { origin: DASHBOARD, cookie: rt } }),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status !== 200).every((r) => r.status === 401)).toBe(true);
    // One rotation: the original (revoked) + exactly one live descendant.
    expect(await prisma.refreshToken.count({ where: { familyId: family } })).toBe(2);
    expect(await prisma.refreshToken.count({ where: { familyId: family, revokedAt: null } })).toBe(
      1,
    );
    // The losers were treated as "already rotated", not as theft: the session survives.
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const winner = results.find((r) => r.status === 200)!;
    const next = cookie(winner.cookies, 'px_rt')!;
    expect(
      (await send('/auth/refresh', { headers: { origin: DASHBOARD, cookie: next } })).status,
    ).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { email } })).sessionVersion).toBe(
      user.sessionVersion,
    );
  });

  it('N-14 (deterministic): two refreshes that both READ the token before either writes — one wins', async () => {
    const { email, password } = await account();
    const login = await send('/auth/login', json({ email, password }, { origin: DASHBOARD }));
    const rt = cookie(login.cookies, 'px_rt')!;
    const rawRt = decodeURIComponent(rt.slice(rt.indexOf('=') + 1));
    // Barrier: both callers finish their read of the token row before either may continue.
    let arrived = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((r) => (release = r));
    const racing = new Proxy(prisma, {
      get(target, prop, receiver) {
        if (prop !== 'refreshToken') return Reflect.get(target, prop, receiver);
        return new Proxy(target.refreshToken, {
          get(rt2, key, r2) {
            if (key !== 'findUnique') return Reflect.get(rt2, key, r2);
            return async (args: unknown) => {
              const row = await target.refreshToken.findUnique(args as never);
              arrived += 1;
              if (arrived === 2) release();
              await bothRead;
              return row;
            };
          },
        });
      },
    });
    const service = new AuthService(
      racing as never,
      new JwtService({ secret: 'it-jwt-secret-0123456789abcdef' }),
      { get: (path: string) => configGet(path) } as never,
    );
    const outcomes = await Promise.allSettled([service.refresh(rawRt), service.refresh(rawRt)]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    expect(String(rejected.reason?.message)).toContain('already rotated');
    const family = (
      await prisma.refreshToken.findUniqueOrThrow({
        where: { tokenHash: createHash('sha256').update(rawRt).digest('hex') },
        select: { familyId: true },
      })
    ).familyId;
    expect(await prisma.refreshToken.count({ where: { familyId: family, revokedAt: null } })).toBe(
      1,
    );
  });

  it('N-15: per-account login throttling applies to every email the same way (no account oracle)', async () => {
    const { email } = await account();
    const unknown = `nobody_${Date.now()}@it.test`;
    for (const target of [email, unknown]) {
      counters.clear(); // isolate from the per-IP bucket (all test traffic shares 127.0.0.1)
      const statuses: number[] = [];
      for (let i = 0; i < 11; i += 1) {
        statuses.push(
          (
            await send(
              '/auth/login',
              json({ email: target, password: 'wrong-password-1' }, { origin: DASHBOARD }),
            )
          ).status,
        );
      }
      expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
      expect(statuses[10]).toBe(429);
    }
  }, 60_000); // 22 bcrypt (cost 12) verifications

  it('logout without a body clears the session and revokes it server-side', async () => {
    const { email, password } = await account();
    const login = await send('/auth/login', json({ email, password }, { origin: DASHBOARD }));
    const before = await prisma.user.findUniqueOrThrow({ where: { email } });
    const out = await send('/auth/logout', {
      headers: { origin: DASHBOARD, cookie: login.cookies.map((c) => c.split(';')[0]).join('; ') },
    });
    expect(out.status).toBe(200);
    const after = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(after.sessionVersion).toBeGreaterThan(before.sessionVersion);
    // A cross-site logout attempt is refused.
    const forced = await send('/auth/logout', { headers: { origin: 'https://evil.example' } });
    expect(forced.status).toBe(403);
  });

  it('registration and password reset accept JSON and refuse forms', async () => {
    run += 1;
    const email = `csrf_reg_${run}_${Date.now()}@it.test`;
    const formReg = await send('/auth/register', {
      body: `email=${encodeURIComponent(email)}&password=correct-horse-battery-9`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: DASHBOARD },
    });
    expect(formReg.status).toBe(415);
    expect(await prisma.user.count({ where: { email } })).toBe(0);
    const reg = await send(
      '/auth/register',
      json({ email, password: 'correct-horse-battery-9' }, { origin: DASHBOARD }),
    );
    expect(reg.status).toBe(201);

    const reset = await send(
      '/auth/password-reset/request',
      json({ email }, { origin: DASHBOARD }),
    );
    expect(reset.status).toBe(202);
    const formReset = await send('/auth/password-reset/request', {
      body: `email=${encodeURIComponent(email)}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: DASHBOARD },
    });
    expect(formReset.status).toBe(415);
    const confirm = await send(
      '/auth/password-reset/confirm',
      json(
        { token: 'x'.repeat(43), newPassword: 'another-horse-battery-9' },
        { origin: DASHBOARD },
      ),
    );
    // A valid request shape reaches the handler, which rejects the unknown token — proof the
    // origin/content-type controls let it through (previously the fixture used a wrong field
    // and was rejected by validation before any control ran).
    expect(confirm.status).toBe(400);
    expect(confirm.body.code).toBe('PASSWORD_RESET_INVALID');
  });
});
