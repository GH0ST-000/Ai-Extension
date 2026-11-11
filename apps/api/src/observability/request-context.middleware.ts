import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';
import { createTraceId, hashUserIdForTelemetry, resolveRequestId } from '@project-x/shared';

import type { ApiConfig } from '../config/configuration';
import { RequestContextService } from './request-context.service';
import { TracingService } from './tracing.service';

const WORKSPACE_ID_HEADER_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  private readonly logger = new Logger(RequestContextMiddleware.name);

  constructor(
    private readonly requestContext: RequestContextService,
    private readonly tracing: TracingService,
    private readonly config: ConfigService<ApiConfig, true>,
  ) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.header('x-request-id') ?? req.header('X-Request-Id');
    const requestId = resolveRequestId(incoming);
    const release = this.config.get('release', { infer: true });
    const environment = this.config.get('nodeEnv', { infer: true });
    const service = this.config.get('service', { infer: true });
    const traceId = createTraceId();
    const sampled = this.tracing.shouldSample(requestId);

    res.setHeader('X-Request-Id', requestId);

    // Absent / blank header → no workspace preference (documented fallback applies).
    // Present but malformed → flagged, so workspace resolution rejects it instead of
    // silently falling back to another workspace.
    const workspaceHeader = req.header('x-workspace-id')?.trim() || undefined;
    const workspaceHeaderValid =
      workspaceHeader !== undefined && WORKSPACE_ID_HEADER_PATTERN.test(workspaceHeader);

    this.requestContext.run(
      {
        requestId,
        traceId,
        sampled,
        release,
        environment,
        service,
        ...(workspaceHeaderValid ? { workspaceId: workspaceHeader } : {}),
        ...(workspaceHeader !== undefined && !workspaceHeaderValid
          ? { workspaceHeaderInvalid: true }
          : {}),
      },
      () => {
        // Attach user hash after auth when available (patched by interceptor/guards).
        const user = (req as Request & { user?: { id?: string } }).user;
        if (user?.id) {
          this.requestContext.patch({ userIdHash: hashUserIdForTelemetry(user.id) });
        }
        next();
      },
    );
  }
}
