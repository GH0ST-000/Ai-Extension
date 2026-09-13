import { Controller, Get, Headers, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type {
  DependencyHealthResponse,
  InternalObservabilityHealthResponse,
} from '@project-x/types';

import type { ApiConfig } from '../config/configuration';
import { ProviderHealthService } from './provider-health.service';

@Controller('health')
export class DependencyHealthController {
  constructor(
    private readonly health: ProviderHealthService,
    private readonly config: ConfigService<ApiConfig, true>,
  ) {}

  @Get('ready')
  async ready(
    @Headers('authorization') authorization?: string,
    @Headers('x-health-token') healthToken?: string,
  ): Promise<DependencyHealthResponse> {
    this.assertDetailsAuthorized(authorization, healthToken);
    const result = await this.health.getDependencies();
    // Readiness focuses on critical local deps; external providers may be degraded.
    const criticalOk =
      result.dependencies.postgres === 'healthy' && result.dependencies.redis === 'healthy';
    return {
      ...result,
      status: criticalOk
        ? result.status === 'unavailable'
          ? 'degraded'
          : result.status
        : 'unavailable',
    };
  }

  @Get('dependencies')
  async dependencies(
    @Headers('authorization') authorization?: string,
    @Headers('x-health-token') healthToken?: string,
  ): Promise<DependencyHealthResponse> {
    this.assertDetailsAuthorized(authorization, healthToken);
    return this.health.getDependencies();
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

    if (!provided || !safeEqualToken(provided, expected)) {
      throw new UnauthorizedException('Invalid health token');
    }
  }
}

@Controller('internal/observability')
export class InternalObservabilityController {
  constructor(
    private readonly health: ProviderHealthService,
    private readonly config: ConfigService<ApiConfig, true>,
  ) {}

  @Get('health')
  async summary(
    @Headers('authorization') authorization?: string,
    @Headers('x-internal-token') internalToken?: string,
  ): Promise<InternalObservabilityHealthResponse> {
    this.assertAuthorized(authorization, internalToken);
    return this.health.getInternalSummary();
  }

  private assertAuthorized(
    authorization: string | undefined,
    internalToken: string | undefined,
  ): void {
    const expected = this.config.get('observability.internalToken', { infer: true });
    const nodeEnv = this.config.get('nodeEnv', { infer: true });

    if (!expected) {
      if (nodeEnv === 'production') {
        throw new UnauthorizedException('Internal observability token required');
      }
      return;
    }

    const provided =
      internalToken?.trim() ||
      (authorization?.toLowerCase().startsWith('bearer ')
        ? authorization.slice(7).trim()
        : undefined);

    if (!provided || !safeEqual(provided, expected)) {
      throw new UnauthorizedException('Invalid internal token');
    }
  }
}

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function safeEqualToken(a: string, b: string): boolean {
  return safeEqual(a, b);
}
