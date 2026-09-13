import { Controller, Get, Headers, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { timingSafeEqual } from 'node:crypto';
import { APP_NAME } from '@project-x/shared';
import type { HealthCheckResponse } from '@project-x/types';

import type { ApiConfig } from '../config/configuration';
import { PrismaHealthIndicator } from './indicators/prisma.health';
import { RedisHealthIndicator } from './indicators/redis.health';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaHealth: PrismaHealthIndicator,
    private readonly redisHealth: RedisHealthIndicator,
    private readonly config: ConfigService<ApiConfig, true>,
  ) {}

  /**
   * Deep dependency check — protected in production via HEALTH_DETAILS_TOKEN.
   * Public callers should use /api/health/live.
   */
  @Get()
  @HealthCheck()
  async check(
    @Headers('authorization') authorization?: string,
    @Headers('x-health-token') healthToken?: string,
  ) {
    this.assertDetailsAuthorized(authorization, healthToken);
    return this.health.check([
      () => this.prismaHealth.isHealthy('database'),
      () => this.redisHealth.isHealthy('redis'),
    ]);
  }

  @Get('live')
  live(): HealthCheckResponse {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      service: APP_NAME,
      version: process.env.APP_RELEASE || process.env.npm_package_version || '0.0.0',
    };
  }

  private assertDetailsAuthorized(
    authorization: string | undefined,
    healthToken: string | undefined,
  ): void {
    const expected = this.config.get('observability.healthDetailsToken', { infer: true });
    const nodeEnv = this.config.get('nodeEnv', { infer: true });

    if (!expected) {
      if (nodeEnv === 'production') {
        throw new UnauthorizedException('Health details token required');
      }
      return;
    }

    const provided =
      healthToken?.trim() ||
      (authorization?.toLowerCase().startsWith('bearer ')
        ? authorization.slice(7).trim()
        : undefined);

    if (!provided || !safeEqual(provided, expected)) {
      throw new UnauthorizedException('Invalid health token');
    }
  }
}

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}
