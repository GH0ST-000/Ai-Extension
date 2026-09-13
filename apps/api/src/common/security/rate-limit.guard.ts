import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { AuthRequestUser } from '../../auth/jwt.strategy';
import { RedisService } from '../../redis/redis.service';

export const RATE_LIMIT_KEY = 'rate_limit';

export type RateLimitPolicy = {
  /** Logical bucket name (auth, ai, write, billing, invite, telemetry, openapi). */
  bucket: string;
  /** Max requests in the window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
};

export const RateLimit = (policy: RateLimitPolicy) => SetMetadata(RATE_LIMIT_KEY, policy);

type RateLimitedRequest = {
  user?: AuthRequestUser;
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
  method?: string;
  url?: string;
};

/**
 * Redis-backed short-window rate limiter.
 * Authenticated: user id. Unauthenticated: IP (do not trust X-Forwarded-For unless proxy is trusted).
 * Fail-closed for auth endpoints; fail-open for others if Redis is unavailable.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly redis: RedisService,
  ) {}

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
      : `ip:${typeof request.ip === 'string' && request.ip ? request.ip : 'unknown'}`;
    const key = `rl:${policy.bucket}:${identity}`;

    try {
      if (this.redis.status === 'wait') {
        await this.redis.connect();
      }
      const count = await this.redis.incr(key);
      if (count === 1) {
        await this.redis.expire(key, policy.windowSeconds);
      }
      if (count > policy.limit) {
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            code: 'RATE_LIMITED',
            message: 'Too many requests. Please wait and try again.',
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      return true;
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      // Auth buckets fail closed; other buckets fail open to preserve availability.
      if (policy.bucket === 'auth' || policy.bucket === 'billing') {
        throw new HttpException(
          {
            statusCode: HttpStatus.SERVICE_UNAVAILABLE,
            code: 'RATE_LIMIT_UNAVAILABLE',
            message: 'Unable to process request right now. Please try again.',
          },
          HttpStatus.SERVICE_UNAVAILABLE,
        );
      }
      return true;
    }
  }
}
