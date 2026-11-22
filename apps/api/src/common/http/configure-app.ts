import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';

import { applyCookieCsrfProtection } from '../security/cookie-csrf';
import { DEV_DASHBOARD_ORIGINS } from '../security/trusted-origins';
import { applyBodyParsers } from './body-parsers';

/**
 * The HTTP security pipeline of the API, in one place. `main.ts` calls this on the real
 * application and the HTTP security tests call it on their test application, so what is
 * tested is what runs — body parsing, cookie CSRF, security headers, proxy trust, validation,
 * the route prefix and CORS cannot drift between the two.
 */
export type HttpAppSettings = {
  nodeEnv: string;
  /** AI_CORS_ORIGINS: dashboard and extension origins (exact). */
  configuredOrigins: readonly string[];
  /** AI_CORS_CONTENT_SCRIPT_ORIGINS: pages the extension's content scripts run on (exact). */
  contentScriptOrigins: readonly string[];
  jsonBodyLimitBytes: number;
  /** Trusted reverse-proxy hops (0 = ignore X-Forwarded-For). */
  trustProxyHops: number;
};

export const CORS_ALLOWED_HEADERS = [
  'Content-Type',
  'Authorization',
  'X-Workspace-Id',
  'X-Request-Id',
  'X-Project-X-Client',
  'Paddle-Signature',
] as const;

export const CORS_EXPOSED_HEADERS = [
  'X-Request-Id',
  'X-PR-Review-Scope',
  'X-Project-Memory',
  'X-AI-Operation-Id',
  'X-AI-Operation-Replayed',
] as const;

/**
 * Whether a browser origin may read API responses (CORS, credentials allowed).
 *
 * - No Origin: not a browser cross-origin request (curl, server-to-server, webhooks).
 * - production: exact match against the configured origins only — never a substring, never a
 *   wildcard, never `null`, never `chrome-extension://*`.
 * - development / test: the allowlist plus the local dashboard origins; only `development`
 *   with NO configured origins reflects any origin (content scripts on arbitrary pages).
 */
export function corsOriginAllowed(
  origin: string | undefined,
  settings: Pick<HttpAppSettings, 'nodeEnv' | 'configuredOrigins' | 'contentScriptOrigins'>,
): boolean {
  if (!origin) return true;
  if (origin === '*' || origin === 'null') return false;
  const { nodeEnv, configuredOrigins, contentScriptOrigins } = settings;
  if (nodeEnv === 'development' || nodeEnv === 'test') {
    return (
      configuredOrigins.includes(origin) ||
      contentScriptOrigins.includes(origin) ||
      (DEV_DASHBOARD_ORIGINS as readonly string[]).includes(origin) ||
      (nodeEnv === 'development' && configuredOrigins.length === 0)
    );
  }
  return configuredOrigins.includes(origin) || contentScriptOrigins.includes(origin);
}

function applySecurityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  );
  // API is consumed cross-origin by the dashboard and extension content scripts.
  // `same-site` would surface as a CORS failure on third-party pages (e.g. selection toolbar).
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
}

export function configureHttpApp(app: NestExpressApplication, settings: HttpAppSettings): void {
  // JSON only (bounded); webhooks keep their raw body for signatures. No form-encoded parser.
  applyBodyParsers(app, settings.jsonBodyLimitBytes);
  // Order matters: the CSRF check reads the parsed cookies.
  app.use(cookieParser());
  // N-4: cookie-authenticated state changes must come from a trusted origin (all routes).
  applyCookieCsrfProtection(app, {
    nodeEnv: settings.nodeEnv,
    configuredOrigins: settings.configuredOrigins,
  });
  app.use(applySecurityHeaders);

  // F-26: honor X-Forwarded-For from exactly the configured number of trusted reverse-proxy
  // hops, so per-IP rate limits key on the client address. Always a hop COUNT — never `true`,
  // which trusts whatever a client sends.
  const express = app.getHttpAdapter().getInstance();
  if (settings.trustProxyHops > 0) {
    express.set('trust proxy', settings.trustProxyHops);
  }
  express.disable('x-powered-by');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.setGlobalPrefix('api');

  app.enableCors({
    origin: (origin, callback) => callback(null, corsOriginAllowed(origin, settings)),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [...CORS_ALLOWED_HEADERS],
    exposedHeaders: [...CORS_EXPOSED_HEADERS],
    maxAge: 600,
  });
}
