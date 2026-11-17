import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  Query,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';

import { Public } from '../auth/public.decorator';
import { RateLimit, RateLimitGuard } from '../common/security/rate-limit.guard';
import type { ApiConfig } from '../config/configuration';
import {
  AnalyticsWindowError,
  ProductAnalyticsService,
  resolveWindow,
  type ProductAnalyticsReport,
} from './product-analytics.service';

/**
 * Operator-only product analytics. Same access model as the existing internal observability
 * endpoints (INTERNAL_OBSERVABILITY_TOKEN, `X-Internal-Token` or Bearer), but stricter: it is
 * closed in every environment while the token is not configured. User sessions (JWT) never
 * grant access — no workspace owner can read platform-wide numbers.
 */
@Public()
@Controller('internal/analytics')
@UseGuards(RateLimitGuard)
export class InternalAnalyticsController {
  constructor(
    private readonly analytics: ProductAnalyticsService,
    private readonly config: ConfigService<ApiConfig, true>,
  ) {}

  @Get('activation')
  @RateLimit({ bucket: 'internal_analytics', limit: 20, windowSeconds: 60 })
  async activation(
    @Headers('authorization') authorization: string | undefined,
    @Headers('x-internal-token') internalToken: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
  ): Promise<ProductAnalyticsReport> {
    this.assertAuthorized(authorization, internalToken);
    const now = new Date();
    let window;
    try {
      window = resolveWindow(from, to, now);
    } catch (error) {
      if (error instanceof AnalyticsWindowError) throw new BadRequestException(error.message);
      throw error;
    }
    return this.analytics.report(window, now);
  }

  private assertAuthorized(authorization: string | undefined, internalToken: string | undefined) {
    const expected = this.config.get('observability.internalToken', { infer: true });
    if (!expected) throw new UnauthorizedException('Internal analytics is not configured.');
    const provided =
      internalToken?.trim() ||
      (authorization?.toLowerCase().startsWith('bearer ')
        ? authorization.slice(7).trim()
        : undefined);
    if (!provided || !safeEqual(provided, expected)) {
      throw new UnauthorizedException('Invalid internal token.');
    }
  }
}

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  return aBuf.length === bBuf.length && timingSafeEqual(aBuf, bBuf);
}
