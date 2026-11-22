import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';

import { ACCESS_COOKIE, REFRESH_COOKIE } from '../../auth/auth-cookies';
import { isTrustedAuthOrigin } from './trusted-origins';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export type CookieCsrfOptions = {
  nodeEnv: string | undefined;
  configuredOrigins: readonly string[];
};

/**
 * N-4 — CSRF defense for EVERY state-changing request authenticated by the session cookie
 * (not only /auth). SameSite=Lax does not stop a sibling subdomain, and a body-less POST is a
 * "simple" request with no CORS preflight, so the server must check where it came from:
 *
 * - Safe methods, requests with an `Authorization: Bearer <token>` header (bearer clients: the extension, CLI —
 *   a cross-site page cannot set that header without a preflight the CORS allowlist refuses),
 *   and requests without a session cookie (webhooks, anonymous) are not affected.
 * - Otherwise an Origin, when sent, must be trusted (the same rule as the M2 login guard);
 *   `Origin: null` is refused. Without an Origin, a browser-labelled `Sec-Fetch-Site:
 *   cross-site` or `same-site` (a sibling subdomain) is refused.
 */
export function cookieCsrfDecision(
  req: Pick<Request, 'method' | 'headers'> & { cookies?: Record<string, unknown> },
  options: CookieCsrfOptions,
): 'allow' | 'deny' {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return 'allow';
  // F-12: only a real bearer credential is exempt. The JWT strategy reads the token from
  // `Authorization: Bearer <token>` and otherwise falls back to the session cookie, so any
  // other Authorization value (`Basic x`, `Bearer` with no token, junk) is still a
  // cookie-authenticated request and must pass the origin check.
  if (isBearerCredential(req.headers.authorization)) {
    return 'allow';
  }
  const cookies = req.cookies ?? {};
  if (!cookies[ACCESS_COOKIE] && !cookies[REFRESH_COOKIE]) return 'allow';

  const origin = req.headers.origin;
  if (typeof origin === 'string') {
    return isTrustedAuthOrigin(origin, options) ? 'allow' : 'deny';
  }
  const site = req.headers['sec-fetch-site'];
  return site === 'cross-site' || site === 'same-site' ? 'deny' : 'allow';
}

/** Mirrors passport-jwt's `fromAuthHeaderAsBearerToken` (scheme `bearer`, one token). */
export function isBearerCredential(header: unknown): boolean {
  return typeof header === 'string' && /^Bearer[ ]+[^\s]+$/i.test(header.trim());
}

export function cookieCsrfMiddleware(options: CookieCsrfOptions) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (cookieCsrfDecision(req, options) === 'allow') {
      next();
      return;
    }
    res.status(403).json({
      statusCode: 403,
      code: 'CSRF_ORIGIN_FORBIDDEN',
      message: 'This request did not come from a trusted Project X origin.',
    });
  };
}

/** Installs the middleware (after cookie-parser), as main.ts does. */
export function applyCookieCsrfProtection(
  app: Pick<NestExpressApplication, 'use'>,
  options: CookieCsrfOptions,
): void {
  app.use(cookieCsrfMiddleware(options));
}
