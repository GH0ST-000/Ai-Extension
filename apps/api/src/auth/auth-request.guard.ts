import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

import { isTrustedAuthOrigin } from '../common/security/trusted-origins';
import type { ApiConfig } from '../config/configuration';

/**
 * CSRF defense for the authentication routes, which set or clear session cookies.
 * Server-side and independent of SameSite (which a sibling subdomain would bypass):
 *
 * 1. Content-Type: a request that carries a body must be `application/json`. HTML forms can
 *    only send `application/x-www-form-urlencoded`, `multipart/form-data` or `text/plain`, so
 *    no cross-site form can reach these handlers (and a cross-site JSON request needs a CORS
 *    preflight). Body-less requests (cookie refresh / logout) have no Content-Type and pass.
 * 2. Origin: when the browser sends an Origin it must be trusted (see isTrustedAuthOrigin).
 *    `Origin: null` (sandboxed frames, data: URLs) is rejected.
 * 3. Missing Origin: allowed — that is how non-browser clients (the extension's service
 *    worker, CLI, server-to-server) call. Browsers always send Origin on cross-site POSTs; as a
 *    backstop, a request a browser labels `Sec-Fetch-Site: cross-site` is rejected even
 *    without an Origin.
 */
@Injectable()
export class AuthRequestGuard implements CanActivate {
  constructor(private readonly config: ConfigService<ApiConfig, true>) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const method = req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;

    const contentType = req.headers['content-type'];
    const hasBody =
      (typeof contentType === 'string' && contentType.length > 0) ||
      Number(req.headers['content-length'] ?? 0) > 0 ||
      req.headers['transfer-encoding'] !== undefined;
    if (hasBody && !isJsonContentType(contentType)) {
      throw new UnsupportedMediaTypeException({
        statusCode: 415,
        code: 'AUTH_JSON_REQUIRED',
        message: 'Authentication requests must be sent as application/json.',
      });
    }

    const origin = req.headers.origin;
    if (typeof origin === 'string') {
      const trusted = isTrustedAuthOrigin(origin, {
        nodeEnv: this.config.get('nodeEnv', { infer: true }),
        configuredOrigins: this.config.get('ai.corsOrigins', { infer: true }) ?? [],
      });
      if (!trusted) throw forbiddenOrigin();
      return true;
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') throw forbiddenOrigin();
    return true;
  }
}

function isJsonContentType(value: string | undefined): boolean {
  if (typeof value !== 'string') return false;
  const mediaType = value.split(';')[0]!.trim().toLowerCase();
  return mediaType === 'application/json';
}

function forbiddenOrigin(): ForbiddenException {
  return new ForbiddenException({
    statusCode: 403,
    code: 'AUTH_ORIGIN_FORBIDDEN',
    message: 'This sign-in request did not come from a trusted Project X origin.',
  });
}
