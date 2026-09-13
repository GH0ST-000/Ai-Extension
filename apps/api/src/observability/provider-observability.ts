import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ObservabilityProviderName } from '@project-x/types';

import type { ApiConfig } from '../config/configuration';
import { MetricsService } from './metrics.service';
import { RequestContextService } from './request-context.service';
import { TracingService } from './tracing.service';

export type ObservedProviderStatus = 'success' | 'failure' | 'timeout' | 'rate_limited';

export interface ObservedProviderCallInput<T> {
  provider: ObservabilityProviderName;
  operation: string;
  errorCodeFor?: (error: unknown) => string | undefined;
  classify?: (error: unknown) => ObservedProviderStatus;
  call: () => Promise<T>;
}

/**
 * Small wrapper for outbound provider calls — span + metrics + structured log.
 * Does not hide provider-specific safety; callers still normalize domain errors.
 */
@Injectable()
export class ProviderObservability {
  private readonly logger = new Logger(ProviderObservability.name);

  constructor(
    private readonly metrics: MetricsService,
    private readonly tracing: TracingService,
    private readonly requestContext: RequestContextService,
    private readonly config: ConfigService<ApiConfig, true>,
  ) {}

  async observe<T>(input: ObservedProviderCallInput<T>): Promise<T> {
    const startedAt = Date.now();
    this.requestContext.patch({ provider: input.provider });

    return this.tracing.startSpan(
      `${input.provider}.${input.operation}`,
      {
        category: 'provider',
        attributes: {
          provider: input.provider,
          operation: input.operation,
        },
      },
      async (span) => {
        try {
          const result = await input.call();
          const durationMs = Date.now() - startedAt;
          const durationSeconds = durationMs / 1000;
          this.metrics.recordProviderRequest({
            provider: input.provider,
            operation: input.operation,
            status: 'success',
            durationSeconds,
          });
          this.logger.log({
            msg: 'provider.request.success',
            event: 'provider.request.success',
            provider: input.provider,
            operation: input.operation,
            durationMs,
            requestId: this.requestContext.get()?.requestId,
            traceId: span.traceId,
          });
          this.warnIfSlow(input.provider, input.operation, durationMs);
          return result;
        } catch (error) {
          const durationMs = Date.now() - startedAt;
          const durationSeconds = durationMs / 1000;
          const status = input.classify?.(error) ?? this.defaultClassify(error);
          const errorCode =
            input.errorCodeFor?.(error) ?? this.defaultErrorCode(error, input.provider);

          span.attributes.status = status;
          span.attributes.errorCode = errorCode;

          this.metrics.recordProviderRequest({
            provider: input.provider,
            operation: input.operation,
            status,
            durationSeconds,
            ...(errorCode ? { errorCode } : {}),
          });

          const level = status === 'rate_limited' || status === 'timeout' ? 'warn' : 'error';
          const payload = {
            msg: 'provider.request.failed',
            event: 'provider.request.failed',
            provider: input.provider,
            operation: input.operation,
            status,
            errorCode,
            durationMs,
            requestId: this.requestContext.get()?.requestId,
            traceId: span.traceId,
          };
          if (level === 'warn') this.logger.warn(payload);
          else this.logger.error(payload);

          throw error;
        }
      },
    );
  }

  observeGithubRateLimit(headers: Headers | Record<string, string | null | undefined>): void {
    try {
      const get = (name: string): string | undefined => {
        if (typeof (headers as Headers).get === 'function') {
          return (headers as Headers).get(name) ?? undefined;
        }
        const record = headers as Record<string, string | null | undefined>;
        return record[name] ?? record[name.toLowerCase()] ?? undefined;
      };
      const remainingRaw = get('x-ratelimit-remaining');
      const resource = get('x-ratelimit-resource') ?? 'core';
      if (remainingRaw != null && remainingRaw !== '') {
        const remaining = Number(remainingRaw);
        if (Number.isFinite(remaining)) {
          this.metrics.setGithubRateLimitRemaining(resource, remaining);
          if (remaining <= 50) {
            this.logger.warn({
              msg: 'github.rate_limit.low',
              event: 'github.rate_limit.low',
              resource,
              remaining,
              requestId: this.requestContext.get()?.requestId,
            });
          }
        }
      }
    } catch {
      // never break product
    }
  }

  private warnIfSlow(provider: string, operation: string, durationMs: number): void {
    const threshold = this.config.get('observability.slowProviderMs', { infer: true });
    if (durationMs >= threshold) {
      this.logger.warn({
        msg: 'provider.request.slow',
        event: 'provider.request.slow',
        provider,
        operation,
        durationMs,
        thresholdMs: threshold,
        requestId: this.requestContext.get()?.requestId,
      });
    }
  }

  private defaultClassify(error: unknown): ObservedProviderStatus {
    const message = error instanceof Error ? error.message.toLowerCase() : '';
    const code =
      typeof error === 'object' && error && 'code' in error
        ? String((error as { code: unknown }).code)
        : '';
    if (code.includes('RATE_LIMIT') || message.includes('rate limit')) {
      return 'rate_limited';
    }
    if (code.includes('TIMEOUT') || message.includes('timeout') || message.includes('aborted')) {
      return 'timeout';
    }
    return 'failure';
  }

  private defaultErrorCode(error: unknown, provider: string): string {
    if (typeof error === 'object' && error && 'code' in error) {
      const code = (error as { code: unknown }).code;
      if (typeof code === 'string' && code.length > 0) return code.slice(0, 64);
    }
    return `${provider.toUpperCase()}_UNAVAILABLE`;
  }
}
