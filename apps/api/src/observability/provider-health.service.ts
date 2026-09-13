import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  DependencyHealthMap,
  DependencyHealthResponse,
  InternalObservabilityHealthResponse,
  ProviderHealthStatus,
} from '@project-x/types';

import type { ApiConfig } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

type Signal = { at: number; ok: boolean };

/**
 * Provider health from readiness probes + recent bounded operational signals.
 * Does NOT call paid AI/GitHub APIs for health checks.
 */
@Injectable()
export class ProviderHealthService {
  private readonly logger = new Logger(ProviderHealthService.name);
  private readonly signals = new Map<string, Signal[]>();
  private static readonly WINDOW_MS = 5 * 60_000;
  private static readonly MAX_SIGNALS = 50;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService<ApiConfig, true>,
  ) {}

  recordSignal(provider: keyof DependencyHealthMap, ok: boolean): void {
    try {
      const list = this.signals.get(provider) ?? [];
      list.push({ at: Date.now(), ok });
      while (list.length > ProviderHealthService.MAX_SIGNALS) list.shift();
      this.signals.set(provider, list);
    } catch {
      // never break product
    }
  }

  async checkPostgres(): Promise<ProviderHealthStatus> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return 'healthy';
    } catch (error) {
      this.logger.warn({
        msg: 'health.postgres.failed',
        error: error instanceof Error ? error.message : 'unknown',
      });
      return 'unavailable';
    }
  }

  async checkRedis(): Promise<ProviderHealthStatus> {
    try {
      if (this.redis.status !== 'ready') {
        await this.redis.connect();
      }
      const pong = await this.redis.ping();
      return pong === 'PONG' ? 'healthy' : 'unavailable';
    } catch (error) {
      this.logger.warn({
        msg: 'health.redis.failed',
        error: error instanceof Error ? error.message : 'unknown',
      });
      return 'unavailable';
    }
  }

  statusFromSignals(provider: keyof DependencyHealthMap): ProviderHealthStatus {
    const now = Date.now();
    const list = (this.signals.get(provider) ?? []).filter(
      (s) => now - s.at <= ProviderHealthService.WINDOW_MS,
    );
    if (list.length === 0) return 'unknown';
    const failures = list.filter((s) => !s.ok).length;
    const rate = failures / list.length;
    if (rate >= 0.8) return 'unavailable';
    if (rate >= 0.2) return 'degraded';
    return 'healthy';
  }

  async getDependencies(): Promise<DependencyHealthResponse> {
    const [postgres, redis] = await Promise.all([this.checkPostgres(), this.checkRedis()]);

    const paddleConfigured = Boolean(this.config.get('paddle.webhookSecret', { infer: true }));
    const aiConfigured = Boolean(this.config.get('ai.openaiApiKey', { infer: true }));

    const dependencies: DependencyHealthMap = {
      postgres,
      redis,
      github: this.statusFromSignals('github'),
      ai: aiConfigured ? this.statusFromSignals('ai') : 'unknown',
      jira: this.statusFromSignals('jira'),
      paddle: paddleConfigured ? this.statusFromSignals('paddle') : 'unknown',
    };

    const status = this.aggregate(dependencies);
    return {
      status,
      dependencies,
      release: this.config.get('release', { infer: true }),
      environment: this.config.get('nodeEnv', { infer: true }),
      timestamp: new Date().toISOString(),
    };
  }

  async getInternalSummary(): Promise<InternalObservabilityHealthResponse> {
    const deps = await this.getDependencies();
    return {
      status: deps.status,
      build: {
        service: this.config.get('service', { infer: true }),
        version: process.env.npm_package_version ?? '0.0.0',
        release: this.config.get('release', { infer: true }),
        environment: this.config.get('nodeEnv', { infer: true }),
        nodeVersion: process.version,
      },
      dependencies: deps.dependencies,
      timestamp: deps.timestamp,
    };
  }

  private aggregate(deps: DependencyHealthMap): ProviderHealthStatus {
    const values = Object.values(deps);
    if (
      values.some((v) => v === 'unavailable') &&
      (deps.postgres === 'unavailable' || deps.redis === 'unavailable')
    ) {
      return 'unavailable';
    }
    if (values.some((v) => v === 'degraded' || v === 'unavailable')) {
      return 'degraded';
    }
    if (values.every((v) => v === 'healthy' || v === 'unknown')) {
      return values.some((v) => v === 'healthy') ? 'healthy' : 'unknown';
    }
    return 'healthy';
  }
}
