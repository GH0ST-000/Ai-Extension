import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createAiOperationId, estimateAiCost, normalizeProviderUsage } from '@project-x/shared';
import type { AICostEstimate, AIUsage } from '@project-x/types';

import type { ApiConfig } from '../config/configuration';
import { MetricsService } from './metrics.service';
import { RequestContextService } from './request-context.service';
import { TracingService } from './tracing.service';

export interface AiObservationResult {
  aiOperationId: string;
  traceId?: string;
  usage: AIUsage;
  cost: AICostEstimate;
  durationMs: number;
  firstTokenLatencyMs?: number;
}

@Injectable()
export class AiObservabilityService {
  private readonly logger = new Logger(AiObservabilityService.name);

  constructor(
    private readonly metrics: MetricsService,
    private readonly tracing: TracingService,
    private readonly requestContext: RequestContextService,
    private readonly config: ConfigService<ApiConfig, true>,
  ) {}

  createOperationId(): string {
    return createAiOperationId();
  }

  async observeGenerate<T>(input: {
    provider: string;
    model: string;
    capability: string;
    call: () => Promise<{
      result: T;
      usageRaw?: Parameters<typeof normalizeProviderUsage>[0];
      providerRequestId?: string;
    }>;
  }): Promise<{ result: T; observation: AiObservationResult }> {
    const aiOperationId = this.createOperationId();
    const startedAt = Date.now();

    return this.tracing.startSpan(
      'ai.request',
      {
        category: 'ai',
        attributes: {
          provider: input.provider,
          model: input.model,
          capability: input.capability,
        },
        forceSample: true,
      },
      async (span) => {
        try {
          const { result, usageRaw, providerRequestId } = await input.call();
          const durationMs = Date.now() - startedAt;
          const usage = normalizeProviderUsage(usageRaw);
          const cost = estimateAiCost({
            provider: input.provider,
            model: input.model,
            usage,
          });

          this.metrics.recordAiRequest({
            provider: input.provider,
            model: input.model,
            capability: input.capability,
            status: 'success',
            durationSeconds: durationMs / 1000,
            ...(usage.inputTokens != null ? { inputTokens: usage.inputTokens } : {}),
            ...(usage.outputTokens != null ? { outputTokens: usage.outputTokens } : {}),
            ...(cost.totalCostUsd != null ? { estimatedCostUsd: cost.totalCostUsd } : {}),
          });

          this.logger.log({
            msg: 'ai.request.success',
            event: 'ai.request.success',
            provider: input.provider,
            model: input.model,
            capability: input.capability,
            aiOperationId,
            durationMs,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            estimatedCostUsd: cost.totalCostUsd,
            pricingVersion: cost.pricingVersion,
            providerRequestId,
            requestId: this.requestContext.get()?.requestId,
            traceId: span.traceId,
          });

          this.warnIfSlow(durationMs, input);

          return {
            result,
            observation: {
              aiOperationId,
              traceId: span.traceId,
              usage,
              cost,
              durationMs,
            },
          };
        } catch (error) {
          const durationMs = Date.now() - startedAt;
          const classified = this.classifyAiError(error);
          this.metrics.recordAiRequest({
            provider: input.provider,
            model: input.model,
            capability: input.capability,
            status: classified.status,
            durationSeconds: durationMs / 1000,
            errorCode: classified.errorCode,
            timedOut: classified.timedOut,
          });
          this.logger.error({
            msg: 'ai.request.failed',
            event: 'ai.request.failed',
            provider: input.provider,
            model: input.model,
            capability: input.capability,
            aiOperationId,
            durationMs,
            errorCode: classified.errorCode,
            requestId: this.requestContext.get()?.requestId,
            traceId: span.traceId,
          });
          throw error;
        }
      },
    );
  }

  recordStreamSuccess(input: {
    provider: string;
    model: string;
    capability: string;
    aiOperationId: string;
    durationMs: number;
    firstTokenLatencyMs?: number;
    usageRaw?: Parameters<typeof normalizeProviderUsage>[0];
    aborted?: boolean;
  }): AiObservationResult {
    const usage = normalizeProviderUsage(input.usageRaw);
    const cost = estimateAiCost({
      provider: input.provider,
      model: input.model,
      usage,
    });
    const ctx = this.requestContext.get();

    this.metrics.recordAiRequest({
      provider: input.provider,
      model: input.model,
      capability: input.capability,
      status: input.aborted ? 'aborted' : 'success',
      durationSeconds: input.durationMs / 1000,
      ...(usage.inputTokens != null ? { inputTokens: usage.inputTokens } : {}),
      ...(usage.outputTokens != null ? { outputTokens: usage.outputTokens } : {}),
      ...(input.firstTokenLatencyMs != null
        ? { firstTokenSeconds: input.firstTokenLatencyMs / 1000 }
        : {}),
      ...(cost.totalCostUsd != null ? { estimatedCostUsd: cost.totalCostUsd } : {}),
    });

    this.logger.log({
      msg: input.aborted ? 'ai.stream.aborted' : 'ai.stream.success',
      event: input.aborted ? 'ai.stream.aborted' : 'ai.stream.success',
      provider: input.provider,
      model: input.model,
      capability: input.capability,
      aiOperationId: input.aiOperationId,
      durationMs: input.durationMs,
      firstTokenLatencyMs: input.firstTokenLatencyMs,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      estimatedCostUsd: cost.totalCostUsd,
      requestId: ctx?.requestId,
      traceId: ctx?.traceId,
    });

    if (!input.aborted) this.warnIfSlow(input.durationMs, input);

    return {
      aiOperationId: input.aiOperationId,
      ...(ctx?.traceId ? { traceId: ctx.traceId } : {}),
      usage,
      cost,
      durationMs: input.durationMs,
      ...(input.firstTokenLatencyMs != null
        ? { firstTokenLatencyMs: input.firstTokenLatencyMs }
        : {}),
    };
  }

  recordStreamFailure(input: {
    provider: string;
    model: string;
    capability: string;
    aiOperationId: string;
    durationMs: number;
    error: unknown;
  }): void {
    const classified = this.classifyAiError(input.error);
    this.metrics.recordAiRequest({
      provider: input.provider,
      model: input.model,
      capability: input.capability,
      status: classified.status === 'aborted' ? 'aborted' : 'failure',
      durationSeconds: input.durationMs / 1000,
      errorCode: classified.errorCode,
      timedOut: classified.timedOut,
    });
    this.logger.error({
      msg: 'ai.stream.failed',
      event: 'ai.stream.failed',
      provider: input.provider,
      model: input.model,
      capability: input.capability,
      aiOperationId: input.aiOperationId,
      durationMs: input.durationMs,
      errorCode: classified.errorCode,
      requestId: this.requestContext.get()?.requestId,
      traceId: this.requestContext.get()?.traceId,
    });
  }

  private warnIfSlow(
    durationMs: number,
    input: { provider: string; model: string; capability: string },
  ): void {
    const threshold = this.config.get('observability.slowAiMs', { infer: true });
    if (durationMs >= threshold) {
      this.logger.warn({
        msg: 'ai.request.slow',
        event: 'ai.request.slow',
        ...input,
        durationMs,
        thresholdMs: threshold,
        requestId: this.requestContext.get()?.requestId,
      });
    }
  }

  private classifyAiError(error: unknown): {
    status: 'failure' | 'aborted';
    errorCode: string;
    timedOut: boolean;
  } {
    const name = error instanceof Error ? error.name : '';
    const message = error instanceof Error ? error.message.toLowerCase() : '';
    if (name === 'AbortError' || message.includes('aborted')) {
      return { status: 'aborted', errorCode: 'AI_ABORTED', timedOut: false };
    }
    if (message.includes('timeout') || name === 'TimeoutError') {
      return { status: 'failure', errorCode: 'AI_TIMEOUT', timedOut: true };
    }
    if (message.includes('rate limit') || message.includes('429')) {
      return { status: 'failure', errorCode: 'AI_RATE_LIMITED', timedOut: false };
    }
    return { status: 'failure', errorCode: 'AI_PROVIDER_UNAVAILABLE', timedOut: false };
  }
}
