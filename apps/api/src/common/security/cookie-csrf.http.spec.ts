import { Controller, HttpCode, Post } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { applyBodyParsers } from '../http/body-parsers';
import { applyCookieCsrfProtection } from './cookie-csrf';

/** Records which state-changing handlers actually ran. */
const reached: string[] = [];

@Controller()
class StateChangingRoutes {
  @Post('workspaces/ws_1/billing/cancel')
  @HttpCode(200)
  cancel() {
    reached.push('billing.cancel');
    return { ok: true };
  }

  @Post('systems/sys_1/relationships/discover')
  @HttpCode(200)
  discover() {
    reached.push('systems.discover');
    return { ok: true };
  }

  @Post('workspace-invitations/tok/accept')
  @HttpCode(200)
  accept() {
    reached.push('invitation.accept');
    return { ok: true };
  }

  @Post('billing/webhook')
  @HttpCode(200)
  webhook() {
    reached.push('billing.webhook');
    return { ok: true };
  }
}

const DASHBOARD = 'https://app.projectx.dev';
const SESSION = 'px_at=session-cookie-value';

describe('N-4: cookie CSRF protection on every state-changing route (HTTP)', () => {
  let app: NestExpressApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [StateChangingRoutes],
    }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      bodyParser: false,
      logger: false,
    });
    // Same order as main.ts: body parsers, cookie-parser, then the CSRF protection.
    applyBodyParsers(app, 100_000);
    app.use(cookieParser());
    applyCookieCsrfProtection(app, { nodeEnv: 'production', configuredOrigins: [DASHBOARD] });
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  });
  afterAll(async () => app?.close());
  beforeEach(() => {
    reached.length = 0;
  });

  const post = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}/api${path}`, { method: 'POST', headers });

  const ROUTES = [
    ['/workspaces/ws_1/billing/cancel', 'billing.cancel'],
    ['/systems/sys_1/relationships/discover', 'systems.discover'],
    ['/workspace-invitations/tok/accept', 'invitation.accept'],
  ] as const;

  it.each(ROUTES)(
    '%s: a hostile origin with the session cookie is refused before the handler',
    async (path) => {
      for (const origin of ['https://evil.example', 'https://evil.projectx.dev', 'null']) {
        const res = await post(path, { cookie: SESSION, origin });
        expect(res.status).toBe(403);
        expect(((await res.json()) as { code?: string }).code).toBe('CSRF_ORIGIN_FORBIDDEN');
      }
      expect(reached).toEqual([]);
    },
  );

  it.each(ROUTES)(
    '%s: a same-site sibling (no Origin, Sec-Fetch-Site) is refused',
    async (path) => {
      for (const site of ['same-site', 'cross-site']) {
        const res = await post(path, { cookie: SESSION, 'sec-fetch-site': site });
        expect(res.status).toBe(403);
      }
      expect(reached).toEqual([]);
    },
  );

  it.each(ROUTES)('%s: the trusted dashboard origin is allowed', async (path, handler) => {
    const res = await post(path, {
      cookie: SESSION,
      origin: DASHBOARD,
      'sec-fetch-site': 'same-site',
    });
    expect(res.status).toBe(200);
    expect(reached).toEqual([handler]);
  });

  it('bearer-token clients (extension, CLI) are unaffected, whatever their origin', async () => {
    const res = await post('/systems/sys_1/relationships/discover', {
      authorization: 'Bearer some.jwt.token',
      origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop',
    });
    expect(res.status).toBe(200);
    expect(reached).toEqual(['systems.discover']);
  });

  // F-12: only `Authorization: Bearer <token>` is a bearer flow. With any other value the JWT
  // strategy authenticates from the cookie, so the origin check must still apply.
  it.each([
    'Basic eA==',
    'x',
    'Bearer',
    'Bearer ',
    'bearer',
    'Token abc',
    'Bearertoken',
    'Negotiate a b',
  ])(
    'a cookie request with Authorization %j from a hostile origin is refused',
    async (authorization) => {
      const res = await post('/workspaces/ws_1/billing/cancel', {
        cookie: SESSION,
        authorization,
        origin: 'https://evil.example',
      });
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code?: string }).code).toBe('CSRF_ORIGIN_FORBIDDEN');
      expect(reached).toEqual([]);
    },
  );

  it('a cookie request with a real bearer header is a bearer flow (allowed)', async () => {
    const res = await post('/workspaces/ws_1/billing/cancel', {
      cookie: SESSION,
      authorization: 'Bearer some.jwt.token',
      origin: 'https://evil.example',
    });
    expect(res.status).toBe(200);
  });

  it('no Origin and no browser fetch metadata (non-browser cookie client) is allowed', async () => {
    const res = await post('/workspaces/ws_1/billing/cancel', { cookie: SESSION });
    expect(res.status).toBe(200);
  });

  it('webhooks (no session cookie) are never affected, even with a foreign origin', async () => {
    const res = await post('/billing/webhook', {
      origin: 'https://hooks.paddle.example',
      'content-type': 'application/json',
    });
    expect(res.status).toBe(200);
    expect(reached).toEqual(['billing.webhook']);
  });

  it('safe methods are never blocked', async () => {
    const res = await fetch(`${baseUrl}/api/workspaces/ws_1/billing/cancel`, {
      method: 'GET',
      headers: { cookie: SESSION, origin: 'https://evil.example' },
    });
    expect(res.status).toBe(404); // no GET route; not 403
  });
});
