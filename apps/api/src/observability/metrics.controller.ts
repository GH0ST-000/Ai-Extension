import { Controller, Get, Headers, UnauthorizedException, Header } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';

import type { ApiConfig } from '../config/configuration';
import { MetricsService } from './metrics.service';

@Controller('metrics')
export class MetricsController {
  constructor(
    private readonly metrics: MetricsService,
    private readonly config: ConfigService<ApiConfig, true>,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async scrape(
    @Headers('authorization') authorization?: string,
    @Headers('x-metrics-token') metricsToken?: string,
  ): Promise<string> {
    this.assertAuthorized(authorization, metricsToken);
    return this.metrics.render();
  }

  private assertAuthorized(
    authorization: string | undefined,
    metricsToken: string | undefined,
  ): void {
    const expected = this.config.get('observability.metricsScrapeToken', {
      infer: true,
    });
    const nodeEnv = this.config.get('nodeEnv', { infer: true });

    if (!expected) {
      if (nodeEnv === 'production') {
        throw new UnauthorizedException('Metrics scrape token required');
      }
      return;
    }

    const provided =
      metricsToken?.trim() ||
      (authorization?.toLowerCase().startsWith('bearer ')
        ? authorization.slice(7).trim()
        : undefined);

    if (!provided || !safeEqual(provided, expected)) {
      throw new UnauthorizedException('Invalid metrics scrape token');
    }
  }
}

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}
