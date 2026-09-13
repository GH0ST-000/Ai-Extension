import { CallHandler, ExecutionContext, Injectable, NestInterceptor, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { hashUserIdForTelemetry, normalizeRouteTemplate } from '@project-x/shared';
import type { Request, Response } from 'express';
import { Observable, tap } from 'rxjs';

import type { ApiConfig } from '../config/configuration';
import { MetricsService } from './metrics.service';
import { RequestContextService } from './request-context.service';

@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  private readonly logger = new Logger(HttpMetricsInterceptor.name);

  constructor(
    private readonly metrics: MetricsService,
    private readonly requestContext: RequestContextService,
    private readonly config: ConfigService<ApiConfig, true>,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const http = context.switchToHttp();
    const req = http.getRequest<Request & { user?: { id?: string } }>();
    const res = http.getResponse<Response>();
    const startedAt = Date.now();

    if (req.user?.id) {
      this.requestContext.patch({ userIdHash: hashUserIdForTelemetry(req.user.id) });
    }

    return next.handle().pipe(
      tap({
        next: () => this.record(req, res, startedAt),
        error: () => this.record(req, res, startedAt),
      }),
    );
  }

  private record(req: Request, res: Response, startedAt: number): void {
    try {
      const durationMs = Date.now() - startedAt;
      const routePath =
        typeof req.route?.path === 'string'
          ? `${req.baseUrl || ''}${req.route.path}`
          : `${req.baseUrl || ''}${req.path || ''}` || req.originalUrl?.split('?')[0] || '/';
      const fullRoute = normalizeRouteTemplate(routePath);

      this.metrics.recordHttpRequest({
        method: req.method,
        route: fullRoute.startsWith('/') ? fullRoute : `/${fullRoute}`,
        statusCode: res.statusCode || 500,
        durationSeconds: durationMs / 1000,
      });

      const slowMs = this.config.get('observability.slowHttpMs', { infer: true });
      const ctx = this.requestContext.get();
      this.logger.log({
        msg: 'http.request.complete',
        event: 'http.request.complete',
        method: req.method,
        route: fullRoute,
        statusCode: res.statusCode,
        durationMs,
        requestId: ctx?.requestId,
        traceId: ctx?.traceId,
        workspaceId: ctx?.workspaceId,
      });

      if (durationMs >= slowMs) {
        this.logger.warn({
          msg: 'http.request.slow',
          event: 'http.request.slow',
          method: req.method,
          route: fullRoute,
          durationMs,
          thresholdMs: slowMs,
          requestId: ctx?.requestId,
        });
      }
    } catch {
      // never break product
    }
  }
}
