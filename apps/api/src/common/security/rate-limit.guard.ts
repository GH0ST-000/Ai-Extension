import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { AuthRequestUser } from '../../auth/jwt.strategy';
import { RedisService } from '../../redis/redis.service';
import { RateLimiter, rateLimitAddressKey } from './rate-limiter';

export const RATE_LIMIT_KEY = 'rate_limit';

export type RateLimitPolicy = {
  /** Logical bucket name (auth, ai, write, billing, invite, telemetry, openapi). */
  bucket: string;
  /** Max requests in the window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
  /**
   * Optional additional cap shared by the whole workspace (same window). Applies on routes
   * whose guards resolved the workspace before this guard (request.workspace).
   */
  perWorkspaceLimit?: number;
  /**
   * Optional second, longer window on the same identity under its own bucket (e.g. a daily
   * cap on account registrations per IP). It expires like any window: never a permanent ban.
   */
  sustained?: { bucket: string; limit: number; windowSeconds: number };
};

export const RateLimit = (policy: RateLimitPolicy) => SetMetadata(RATE_LIMIT_KEY, policy);

type RateLimitedRequest = {
  user?: AuthRequestUser;
  workspace?: { workspaceId?: string };
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
  method?: string;
  url?: string;
};

/**
 * Short-window rate limiter on routes declaring @RateLimit. Authenticated: per user id.
 * Unauthenticated: per IP (X-Forwarded-For only behind the trusted proxy hop).
 * Storage and Redis-outage behavior: see RateLimiter (bounded in-process fallback, N-15).
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly limiter: RateLimiter;

  constructor(
    private readonly reflector: Reflector,
    private readonly redis: RedisService,
  ) {
    this.limiter = new RateLimiter(redis);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const policy = this.reflector.getAllAndOverride<RateLimitPolicy | undefined>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!policy) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RateLimitedRequest>();
    const identity = request.user?.id
      ? `u:${request.user.id}`
      : `ip:${rateLimitAddressKey(request.ip)}`;
    await this.limiter.consume(
      `rl:${policy.bucket}:${identity}`,
      policy.limit,
      policy.windowSeconds,
    );
    if (policy.sustained) {
      await this.limiter.consume(
        `rl:${policy.sustained.bucket}:${identity}`,
        policy.sustained.limit,
        policy.sustained.windowSeconds,
      );
    }
    const workspaceId = request.workspace?.workspaceId;
    if (policy.perWorkspaceLimit !== undefined && workspaceId) {
      await this.limiter.consume(
        `rl:${policy.bucket}:ws:${workspaceId}`,
        policy.perWorkspaceLimit,
        policy.windowSeconds,
      );
    }
    return true;
  }
}
