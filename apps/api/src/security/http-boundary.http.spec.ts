/**
 * HTTP security boundary of the API, exercised over real HTTP against an application
 * configured by the SAME function `main.ts` uses (`configureHttpApp`), with the real global
 * JWT guard and strategy, the real webhook controllers and the real billing webhook handler.
 *
 * What is real: body parsing (raw bodies for webhooks), cookie parsing, cookie-CSRF
 * middleware, security headers, proxy trust, ValidationPipe, the `/api` prefix, CORS,
 * JwtAuthGuard as APP_GUARD, JwtStrategy (signature, expiry, session version), both webhook
 * signature verifications. Stubbed: the database (an in-memory user table / spies).
 */
import { createHmac } from 'node:crypto';

import { Body, Controller, Get, Module, Post, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { IsString } from 'class-validator';
import type { Request } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { JwtStrategy } from '../auth/jwt.strategy';
import { Public } from '../auth/public.decorator';
import { BillingService } from '../billing/billing.service';
import { PaddleWebhookController } from '../billing/paddle-webhook.controller';
import { buildPaddleWebhookSignatureHeader } from '../billing/paddle-webhook-signature';
import { configureHttpApp } from '../common/http/configure-app';
import { GithubAppApiClient } from '../github-app/github-app-api.client';
import { GithubAppInstallationService } from '../github-app/github-app-installation.service';
import { GithubAppWebhookController } from '../github-app/github-app-webhook.controller';
import { PrismaService } from '../prisma/prisma.service';

const JWT_SECRET = 'http-boundary-jwt-secret-0123456789abcdef';
const GITHUB_WEBHOOK_SECRET = 'github-webhook-secret-0123456789';
const PADDLE_WEBHOOK_SECRET = 'paddle-webhook-secret-0123456789';
const DASHBOARD = 'https://app.projectx-fixture.dev';
const EXTENSION = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

class ProbeDto {
  @IsString()
  value!: string;
}

@Controller('probe')
class ProbeController {
  @Get('private')
  privateRead(@Req() req: Request & { user?: { id: string } }) {
    return { user: req.user?.id, ip: req.ip };
  }

  @Post('private')
  privateWrite(@Req() req: Request & { user?: { id: string } }, @Body() body: ProbeDto) {
    return { user: req.user?.id, value: body.value };
  }

  @Public()
  @Get('public')
  publicRead() {
    return { ok: true };
  }
}

describe('HTTP security boundary (real bootstrap pipeline)', () => {
  const users = new Map<
    string,
    { id: string; email: string; name: null; sessionVersion: number }
  >();
  const installations = {
    markInstallationRemoved: vi.fn(async () => undefined),
    markInstallationSuspended: vi.fn(async () => undefined),
    getWorkspaceIdForInstallation: vi.fn(async () => null),
    upsertFromGitHubInstallation: vi.fn(async () => undefined),
  };
  const billingPrisma = {
    billingWebhookEvent: { findUnique: vi.fn(async () => null), create: vi.fn(async () => ({})) },
    workspaceSubscription: { findUnique: vi.fn(async () => null), upsert: vi.fn(async () => ({})) },
    billingCheckout: {
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => null),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    $queryRaw: vi.fn(async () => [{ status: 'active' }]),
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(billingPrisma)),
  };
  const jwt = new JwtService({ secret: JWT_SECRET });
  const apps: NestExpressApplication[] = [];

  async function boot(overrides: { trustProxyHops?: number; nodeEnv?: string } = {}) {
    const configValues: Record<string, unknown> = {
      'jwt.secret': JWT_SECRET,
      'githubApp.webhookSecret': GITHUB_WEBHOOK_SECRET,
      nodeEnv: 'test',
      paddle: {
        environment: 'sandbox',
        apiKey: '',
        webhookSecret: PADDLE_WEBHOOK_SECRET,
        clientToken: '',
        prices: {
          proMonthly: 'pri_pro_m',
          proYearly: '',
          teamMonthly: 'pri_team_m',
          teamYearly: '',
        },
      },
    };
    const config = {
      get: (key: string) => configValues[key],
      getOrThrow: (key: string) => configValues[key],
    };
    const prisma = {
      user: {
        findUnique: async ({ where }: { where: { id: string } }) => users.get(where.id) ?? null,
      },
    };

    @Module({
      imports: [PassportModule.register({ defaultStrategy: 'jwt' })],
      controllers: [ProbeController, GithubAppWebhookController, PaddleWebhookController],
      providers: [
        { provide: ConfigService, useValue: config },
        { provide: PrismaService, useValue: prisma },
        JwtStrategy,
        // The production default: every route needs a valid session unless @Public().
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: GithubAppInstallationService, useValue: installations },
        { provide: GithubAppApiClient, useValue: { fetchInstallation: vi.fn() } },
        {
          provide: BillingService,
          useFactory: () =>
            new BillingService(
              billingPrisma as never,
              config as never,
              { invalidate: vi.fn(), getPlanId: vi.fn(), getEntitlements: vi.fn() } as never,
              { getUsageCounters: vi.fn(async () => []) } as never,
            ),
        },
      ],
    })
    class BoundaryModule {}

    const moduleRef = await Test.createTestingModule({ imports: [BoundaryModule] }).compile();
    // Same creation options as main.ts.
    const app = moduleRef.createNestApplication<NestExpressApplication>({
      logger: false,
      rawBody: true,
      bodyParser: false,
    });
    configureHttpApp(app, {
      nodeEnv: overrides.nodeEnv ?? 'production',
      configuredOrigins: [DASHBOARD, EXTENSION],
      contentScriptOrigins: ['https://github.com'],
      jsonBodyLimitBytes: 16_384,
      trustProxyHops: overrides.trustProxyHops ?? 1,
    });
    await app.listen(0, '127.0.0.1');
    apps.push(app);
    return (await app.getUrl()).replace('[::1]', '127.0.0.1');
  }

  let base: string;
  beforeAll(async () => {
    base = await boot();
  });
  afterAll(async () => {
    await Promise.all(apps.map((app) => app.close()));
  });
  beforeEach(() => {
    users.clear();
    users.set('u1', { id: 'u1', email: 'u1@example.com', name: null, sessionVersion: 3 });
    vi.clearAllMocks();
    billingPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
      fn(billingPrisma),
    );
    billingPrisma.$queryRaw.mockResolvedValue([{ status: 'active' }]);
    billingPrisma.billingWebhookEvent.findUnique.mockResolvedValue(null);
  });

  const token = (claims: Record<string, unknown> = {}, options: Record<string, unknown> = {}) =>
    jwt.sign(
      { sub: 'u1', email: 'u1@example.com', sv: 3, ...claims },
      { expiresIn: '5m', ...options },
    );
  const call = (path: string, init: RequestInit = {}) => fetch(`${base}/api${path}`, init);

  // ── global authentication ────────────────────────────────────────────────

  describe('global authentication', () => {
    it('a route without @Public() needs a session; @Public() routes do not', async () => {
      expect((await call('/probe/private')).status).toBe(401);
      expect((await call('/probe/private', { method: 'POST', body: '{}' })).status).toBe(401);
      expect((await call('/probe/public')).status).toBe(200);
    });

    it('accepts a valid bearer token and a valid session cookie', async () => {
      const bearer = await call('/probe/private', {
        headers: { authorization: `Bearer ${token()}` },
      });
      expect(bearer.status).toBe(200);
      expect(((await bearer.json()) as { user: string }).user).toBe('u1');
      const cookie = await call('/probe/private', { headers: { cookie: `px_at=${token()}` } });
      expect(cookie.status).toBe(200);
    });

    it.each([
      [
        'a token signed with another secret',
        () => new JwtService({ secret: 'x'.repeat(40) }).sign({ sub: 'u1', sv: 3 }),
      ],
      ['an expired token', () => token({}, { expiresIn: '-10s' })],
      ['a token of an older session version (logged out / password reset)', () => token({ sv: 2 })],
      [
        'a token without a session version when the account has one',
        () => token({ sv: undefined }),
      ],
      ['a token for a user that does not exist', () => token({ sub: 'ghost' })],
      [
        'an unsigned (alg=none) token',
        () =>
          `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from(
            JSON.stringify({ sub: 'u1', sv: 3, exp: Math.floor(Date.now() / 1000) + 300 }),
          ).toString('base64url')}.`,
      ],
      ['garbage', () => 'not-a-jwt'],
    ])('rejects %s', async (_name, make) => {
      const value = make();
      expect(
        (await call('/probe/private', { headers: { authorization: `Bearer ${value}` } })).status,
      ).toBe(401);
      expect((await call('/probe/private', { headers: { cookie: `px_at=${value}` } })).status).toBe(
        401,
      );
    });

    it('an invalid bearer token is not rescued by a valid cookie (no cross-credential confusion)', async () => {
      const res = await call('/probe/private', {
        headers: { authorization: 'Bearer not-a-jwt', cookie: `px_at=${token()}` },
      });
      expect(res.status).toBe(401);
    });
  });

  // ── CSRF and request parsing ─────────────────────────────────────────────

  describe('cookie CSRF, validation and headers are wired into the pipeline', () => {
    const write = (headers: Record<string, string>, body = '{"value":"x"}') =>
      call('/probe/private', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body,
      });

    it('a cookie-authenticated write from an untrusted origin is refused before the handler', async () => {
      const res = await write({ cookie: `px_at=${token()}`, origin: 'https://evil.example' });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe('CSRF_ORIGIN_FORBIDDEN');
    });

    it('the same write is refused with a non-bearer Authorization header (F-12)', async () => {
      const res = await write({
        cookie: `px_at=${token()}`,
        origin: 'https://evil.example',
        authorization: 'Basic eA==',
      });
      expect(res.status).toBe(403);
    });

    it('the same write from the dashboard origin, and a bearer write, succeed', async () => {
      expect((await write({ cookie: `px_at=${token()}`, origin: DASHBOARD })).status).toBe(201);
      expect((await write({ authorization: `Bearer ${token()}`, origin: EXTENSION })).status).toBe(
        201,
      );
    });

    it('unknown properties and oversized or non-JSON bodies are rejected', async () => {
      const auth = { authorization: `Bearer ${token()}` };
      expect((await write(auth, '{"value":"x","role":"owner"}')).status).toBe(400);
      expect((await write(auth, JSON.stringify({ value: 'x'.repeat(20_000) }))).status).toBe(413);
      const form = await call('/probe/private', {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' },
        body: 'value=x',
      });
      expect(form.status).toBe(400); // not parsed: the DTO is empty
    });

    it('sets the security headers and does not advertise the framework', async () => {
      const res = await call('/probe/public');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('x-powered-by')).toBeNull();
    });
  });

  // ── CORS over HTTP ───────────────────────────────────────────────────────

  describe('CORS (preflight of the running app)', () => {
    const preflight = (origin: string) =>
      call('/probe/private', {
        method: 'OPTIONS',
        headers: {
          origin,
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization,content-type',
        },
      });

    it.each([DASHBOARD, EXTENSION, 'https://github.com'])(
      'allows the configured origin %s with credentials',
      async (origin) => {
        const res = await preflight(origin);
        expect(res.headers.get('access-control-allow-origin')).toBe(origin);
        expect(res.headers.get('access-control-allow-credentials')).toBe('true');
      },
    );

    it.each([
      'https://evil.example',
      `${DASHBOARD}.evil.example`,
      'https://app.projectx-fixture.dev:8443',
      'http://localhost:3000',
      'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba',
      'null',
    ])('gives %s no CORS permission', async (origin) => {
      const res = await preflight(origin);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });

    it('never answers with a wildcard origin', async () => {
      for (const origin of [DASHBOARD, 'https://evil.example']) {
        expect((await preflight(origin)).headers.get('access-control-allow-origin')).not.toBe('*');
      }
    });
  });

  // ── proxy trust ──────────────────────────────────────────────────────────

  describe('X-Forwarded-For (F-26)', () => {
    const ipSeen = async (url: string, forwarded: string) => {
      const res = await fetch(`${url}/api/probe/private`, {
        headers: { authorization: `Bearer ${token()}`, 'x-forwarded-for': forwarded },
      });
      return ((await res.json()) as { ip: string }).ip;
    };

    it('with one trusted hop, only the address added by that proxy is used (the client-supplied part is ignored)', async () => {
      expect(await ipSeen(base, '203.0.113.50')).toBe('203.0.113.50');
      // A client that sends its own X-Forwarded-For only prepends to the list.
      expect(await ipSeen(base, '10.9.9.9, 1.2.3.4, 203.0.113.50')).toBe('203.0.113.50');
    });

    it('with no trusted proxy the header is ignored entirely', async () => {
      const direct = await boot({ trustProxyHops: 0 });
      expect(await ipSeen(direct, '203.0.113.50')).toMatch(/127\.0\.0\.1$/);
    });

    it('with two trusted hops the address two from the right is used', async () => {
      const twoHops = await boot({ trustProxyHops: 2 });
      expect(await ipSeen(twoHops, '6.6.6.6, 198.51.100.7, 203.0.113.50')).toBe('198.51.100.7');
    });
  });

  // ── GitHub App webhook ───────────────────────────────────────────────────

  describe('GitHub App webhook signature', () => {
    // Deliberately unusual spacing: the signature covers the exact bytes sent.
    const body = '{ "action":"deleted",\n  "installation": {"id": 4242} }';
    const sign = (payload: string, secret = GITHUB_WEBHOOK_SECRET) =>
      `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
    const deliver = (headers: Record<string, string>, payload = body) =>
      call('/webhooks/github-app', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'installation',
          ...headers,
        },
        body: payload,
      });

    it('processes a delivery signed over the raw body (no session needed)', async () => {
      const res = await deliver({ 'x-hub-signature-256': sign(body) });
      expect(res.status).toBe(201);
      expect(installations.markInstallationRemoved).toHaveBeenCalledWith('4242');
    });

    it.each([
      ['no signature header', {}],
      [
        'a signature made with another secret',
        { 'x-hub-signature-256': sign(body, 'other-secret-0123456789abcdef') },
      ],
      [
        'a signature of a different body',
        { 'x-hub-signature-256': sign('{"action":"deleted","installation":{"id":1}}') },
      ],
      [
        'a signature of the re-serialized (not raw) body',
        { 'x-hub-signature-256': sign(JSON.stringify(JSON.parse(body))) },
      ],
      [
        'a SHA-1 style signature',
        {
          'x-hub-signature-256': `sha1=${createHmac('sha1', GITHUB_WEBHOOK_SECRET).update(body).digest('hex')}`,
        },
      ],
      ['a truncated signature', { 'x-hub-signature-256': sign(body).slice(0, 30) }],
      ['an empty signature', { 'x-hub-signature-256': 'sha256=' }],
    ])('rejects %s and changes nothing', async (_name, headers) => {
      const res = await deliver(headers as Record<string, string>);
      expect(res.status).toBe(401);
      expect(installations.markInstallationRemoved).not.toHaveBeenCalled();
      expect(installations.markInstallationSuspended).not.toHaveBeenCalled();
    });

    it('a valid session does not replace the signature', async () => {
      const res = await deliver({ authorization: `Bearer ${token()}` });
      expect(res.status).toBe(401);
      expect(installations.markInstallationRemoved).not.toHaveBeenCalled();
    });
  });

  // ── Paddle webhook ───────────────────────────────────────────────────────

  describe('Paddle webhook signature', () => {
    const event = JSON.stringify({
      event_id: 'evt_boundary_1',
      event_type: 'subscription.updated',
      occurred_at: new Date().toISOString(),
      data: {
        id: 'sub_1',
        status: 'active',
        custom_data: { workspaceId: 'ws_1' },
        items: [{ price: { id: 'pri_pro_m' } }],
      },
    });
    const deliver = (signature?: string, payload = event) =>
      call('/webhooks/paddle', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(signature ? { 'paddle-signature': signature } : {}),
        },
        body: payload,
      });
    const valid = (payload = event, ts?: number) =>
      buildPaddleWebhookSignatureHeader(Buffer.from(payload), PADDLE_WEBHOOK_SECRET, { ts });

    it('accepts a correctly signed event and records it', async () => {
      const res = await deliver(valid());
      expect(res.status).toBe(201);
      expect(billingPrisma.billingWebhookEvent.create).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['no signature', () => undefined],
      [
        'a signature with another secret',
        () => buildPaddleWebhookSignatureHeader(Buffer.from(event), 'another-secret-0123456789'),
      ],
      ['a signature of a different body', () => valid(event.replace('ws_1', 'ws_2'))],
      ['a stale timestamp (replay)', () => valid(event, Math.floor(Date.now() / 1000) - 3_600)],
      ['a malformed header', () => 'ts=abc;h1=zz'],
    ])('rejects %s without touching billing state', async (_name, make) => {
      const res = await deliver(make());
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('BILLING_WEBHOOK_INVALID');
      expect(billingPrisma.billingWebhookEvent.create).not.toHaveBeenCalled();
      expect(billingPrisma.workspaceSubscription.upsert).not.toHaveBeenCalled();
    });

    it('a signed event for a workspace without a matching checkout changes no subscription (F-02)', async () => {
      await deliver(valid());
      expect(billingPrisma.workspaceSubscription.upsert).not.toHaveBeenCalled();
    });
  });
});
