import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { APP_NAME } from '@project-x/shared';
import type { HealthCheckResponse } from '@project-x/types';

import { PrismaHealthIndicator } from './indicators/prisma.health';
import { RedisHealthIndicator } from './indicators/redis.health';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaHealth: PrismaHealthIndicator,
    private readonly redisHealth: RedisHealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  async check() {
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
      version: process.env.npm_package_version ?? '0.0.0',
    };
  }
}
