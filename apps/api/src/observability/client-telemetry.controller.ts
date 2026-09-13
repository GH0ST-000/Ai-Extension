import { Body, Controller, Headers, HttpCode, Post, Req, UseGuards, Logger } from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength, Matches } from 'class-validator';
import type { Request } from 'express';
import {
  isClientTelemetryEvent,
  isSafeTelemetryComponent,
  redactSensitiveString,
  createRequestId,
} from '@project-x/shared';
import type {
  ClientErrorTelemetryInput,
  ClientErrorTelemetryResponse,
  ClientTelemetryClient,
  ClientTelemetryEvent,
  ClientTelemetryIntegration,
} from '@project-x/types';

import type { AuthRequestUser } from '../auth/jwt.strategy';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RedisService } from '../redis/redis.service';
import { ERROR_TRACKER, type ErrorTracker } from './error-tracker';
import { MetricsService } from './metrics.service';
import { RequestContextService } from './request-context.service';
import { Inject, Optional } from '@nestjs/common';

const MAX_STACK = 2_000;
const RATE_LIMIT_WINDOW_SEC = 60;
const RATE_LIMIT_MAX = 30;

export class ClientErrorTelemetryDto {
  @IsIn(['extension', 'dashboard'])
  client!: ClientTelemetryClient;

  @IsString()
  @MaxLength(64)
  @Matches(/^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/)
  component!: string;

  @IsString()
  @MaxLength(64)
  event!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  release?: string;

  @IsOptional()
  @IsIn(['github', 'jira', 'swagger', 'generic'])
  integration?: ClientTelemetryIntegration;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  errorCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  normalizedMessage?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  requestId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  executionId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_STACK)
  stack?: string;
}

/**
 * Strict allowlisted client error ingest.
 * Rejects arbitrary metadata / page URLs / selected text.
 */
@Controller('telemetry')
export class ClientTelemetryController {
  private readonly logger = new Logger(ClientTelemetryController.name);

  constructor(
    private readonly metrics: MetricsService,
    private readonly requestContext: RequestContextService,
    private readonly redis: RedisService,
    @Optional() @Inject(ERROR_TRACKER) private readonly errorTracker?: ErrorTracker,
  ) {}

  @Post('client-errors')
  @HttpCode(202)
  @UseGuards(JwtAuthGuard)
  async ingest(
    @CurrentUser() user: AuthRequestUser,
    @Body() body: ClientErrorTelemetryDto,
    @Req() req: Request,
    @Headers('x-request-id') incomingRequestId?: string,
  ): Promise<ClientErrorTelemetryResponse> {
    if (!isClientTelemetryEvent(body.event) || !isSafeTelemetryComponent(body.component)) {
      this.metrics.recordClientTelemetry(body.client, 'rejected', 'rejected');
      return { accepted: false };
    }

    const limited = await this.isRateLimited(user.id);
    if (limited) {
      this.metrics.recordRateLimitRejection('client_telemetry', 'telemetry');
      this.metrics.recordClientTelemetry(body.client, body.event, 'rate_limited');
      return { accepted: false };
    }

    const referenceId = createRequestId();
    const stack = body.stack ? redactSensitiveString(body.stack).slice(0, MAX_STACK) : undefined;
    const normalizedMessage = body.normalizedMessage
      ? redactSensitiveString(body.normalizedMessage).slice(0, 240)
      : undefined;

    const payload: ClientErrorTelemetryInput = {
      client: body.client,
      component: body.component,
      event: body.event as ClientTelemetryEvent,
      ...(body.release ? { release: body.release.slice(0, 128) } : {}),
      ...(body.integration ? { integration: body.integration } : {}),
      ...(body.errorCode ? { errorCode: body.errorCode.slice(0, 64) } : {}),
      ...(normalizedMessage ? { normalizedMessage } : {}),
      ...(body.requestId ? { requestId: body.requestId } : {}),
      ...(body.executionId ? { executionId: body.executionId } : {}),
      ...(stack ? { stack } : {}),
    };

    // Forbidden fields must never appear — schema has no URL/selectedText/metadata.
    this.logger.warn({
      msg: 'client.telemetry.error',
      event: 'client.telemetry.error',
      client: payload.client,
      component: payload.component,
      clientEvent: payload.event,
      integration: payload.integration,
      errorCode: payload.errorCode,
      referenceId,
      requestId: payload.requestId ?? incomingRequestId ?? this.requestContext.get()?.requestId,
      executionId: payload.executionId,
      release: payload.release,
    });

    try {
      this.errorTracker?.captureMessage(`client.${payload.client}.${payload.event}`, 'warn', {
        ...this.requestContext.snapshot(),
        errorCode: payload.errorCode,
        tags: {
          client: payload.client,
          component: payload.component,
          client_event: payload.event,
          ...(payload.integration ? { integration: payload.integration } : {}),
        },
        extra: {
          referenceId,
          normalizedMessage: payload.normalizedMessage,
          stackFingerprint: stack?.slice(0, 400),
        },
        fingerprint: [
          payload.client,
          payload.component,
          payload.event,
          payload.errorCode ?? 'none',
        ],
      });
    } catch {
      // never break product
    }

    this.metrics.recordClientTelemetry(payload.client, payload.event, 'accepted');
    void req;
    return { accepted: true, referenceId };
  }

  private async isRateLimited(userId: string): Promise<boolean> {
    try {
      if (this.redis.status !== 'ready') {
        await this.redis.connect();
      }
      const key = `telemetry:rl:${userId}`;
      const count = await this.redis.incr(key);
      if (count === 1) {
        await this.redis.expire(key, RATE_LIMIT_WINDOW_SEC);
      }
      return count > RATE_LIMIT_MAX;
    } catch {
      return false;
    }
  }
}
