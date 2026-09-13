import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
  Optional,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { ERROR_TRACKER, type ErrorTracker } from './error-tracker';
import { RequestContextService } from './request-context.service';

/**
 * Capture unexpected 5xx only — expected 4xx stay metrics/logs without Sentry noise.
 */
@Catch()
export class ObservabilityExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ObservabilityExceptionFilter.name);

  constructor(
    private readonly requestContext: RequestContextService,
    @Optional() @Inject(ERROR_TRACKER) private readonly errorTracker?: ErrorTracker,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    const obs = this.requestContext.snapshot();
    const requestId = obs.requestId;

    if (status >= 500) {
      const errorCode = this.extractCode(exception) ?? 'INTERNAL_ERROR';
      this.logger.error({
        msg: 'http.unhandled_error',
        event: 'http.unhandled_error',
        statusCode: status,
        errorCode,
        path: request.route?.path ?? request.path,
        method: request.method,
        requestId,
        traceId: obs.traceId,
        executionId: obs.executionId,
      });

      try {
        this.errorTracker?.captureException(exception, {
          ...obs,
          errorCode,
          tags: { status_class: '5xx' },
        });
      } catch {
        // never break product
      }
    }

    if (response.headersSent) {
      return;
    }

    if (requestId && !response.getHeader('X-Request-Id')) {
      response.setHeader('X-Request-Id', requestId);
    }

    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      response.status(status).json(
        typeof body === 'string'
          ? { statusCode: status, message: body, ...(requestId ? { requestId } : {}) }
          : {
              ...(typeof body === 'object' && body ? body : {}),
              ...(requestId ? { requestId } : {}),
            },
      );
      return;
    }

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Internal server error',
      error: 'Internal Server Error',
      ...(requestId ? { requestId } : {}),
    });
  }

  private extractCode(exception: unknown): string | undefined {
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      if (typeof body === 'object' && body && 'code' in body) {
        const code = (body as { code: unknown }).code;
        if (typeof code === 'string') return code;
      }
    }
    return undefined;
  }
}
