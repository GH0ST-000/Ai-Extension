import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSpanId, createTraceId, safeTelemetryMetadata } from '@project-x/shared';

import type { ApiConfig } from '../config/configuration';
import { RequestContextService } from './request-context.service';

export type SpanStatus = 'ok' | 'error' | 'unset';

export interface SpanAttributes {
  provider?: string;
  operation?: string;
  capability?: string;
  model?: string;
  status?: string;
  retryCount?: number;
  contextType?: string;
  repositoryProvider?: string;
  plan?: string;
  feature?: string;
  resultType?: string;
  errorCode?: string;
  [key: string]: string | number | boolean | undefined;
}

export interface ActiveSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  category?: string;
  startMs: number;
  sampled: boolean;
  attributes: SpanAttributes;
}

/**
 * Lightweight internal tracing compatible with future OTel.
 * Uses Sentry only as optional error correlation — no dual full APM pipelines.
 */
@Injectable()
export class TracingService {
  private readonly logger = new Logger(TracingService.name);

  constructor(
    private readonly config: ConfigService<ApiConfig, true>,
    private readonly requestContext: RequestContextService,
  ) {}

  shouldSample(seed?: string): boolean {
    const rate = this.config.get('observability.traceSampleRate', { infer: true });
    if (rate <= 0) return false;
    if (rate >= 1) return true;
    if (seed) {
      let hash = 0;
      for (let i = 0; i < seed.length; i += 1) {
        hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
      }
      return hash % 10_000 < Math.floor(rate * 10_000);
    }
    return Math.random() < rate;
  }

  ensureTrace(seed?: string): { traceId: string; sampled: boolean } {
    const current = this.requestContext.get();
    if (current?.traceId) {
      return { traceId: current.traceId, sampled: current.sampled !== false };
    }
    const traceId = createTraceId();
    const sampled = this.shouldSample(seed ?? traceId);
    this.requestContext.patch({ traceId, sampled });
    return { traceId, sampled };
  }

  async startSpan<T>(
    name: string,
    options: {
      category?: string;
      attributes?: SpanAttributes;
      forceSample?: boolean;
    },
    fn: (span: ActiveSpan) => Promise<T> | T,
  ): Promise<T> {
    const parent = this.requestContext.get();
    const { traceId, sampled: baseSampled } = this.ensureTrace(
      parent?.executionId ?? parent?.requestId,
    );
    const sampled = options.forceSample === true || baseSampled;
    const spanId = createSpanId();
    const span: ActiveSpan = {
      traceId,
      spanId,
      ...(parent?.spanId ? { parentSpanId: parent.spanId } : {}),
      name,
      ...(options.category ? { category: options.category } : {}),
      startMs: Date.now(),
      sampled,
      attributes: { ...(options.attributes ?? {}) },
    };

    const previousSpanId = parent?.spanId;
    this.requestContext.patch({ spanId, traceId, sampled });

    let status: SpanStatus = 'unset';
    try {
      const result = await fn(span);
      status = 'ok';
      return result;
    } catch (error) {
      status = 'error';
      if (error instanceof Error) {
        const maybeCode = (error as unknown as { code?: unknown }).code;
        span.attributes.errorCode =
          span.attributes.errorCode ?? (typeof maybeCode === 'string' ? maybeCode : error.name);
      }
      throw error;
    } finally {
      const durationMs = Date.now() - span.startMs;
      if (sampled) {
        try {
          const safeAttrs = safeTelemetryMetadata(span.attributes as Record<string, unknown>);
          this.logger.log({
            msg: 'trace.span',
            event: 'trace.span',
            spanName: name,
            category: options.category,
            traceId,
            spanId,
            parentSpanId: span.parentSpanId,
            status,
            durationMs,
            ...(safeAttrs ?? {}),
          });
        } catch {
          // never break product
        }
      }
      this.requestContext.patch({
        spanId: previousSpanId,
      });
    }
  }
}
