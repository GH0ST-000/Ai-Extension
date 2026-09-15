import { Global, Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';

import type { ApiConfig } from '../config/configuration';
import { AiObservabilityService } from './ai-observability.service';
import { ClientTelemetryController } from './client-telemetry.controller';
import { ERROR_TRACKER } from './error-tracker';
import {
  DependencyHealthController,
  InternalObservabilityController,
} from './health-observability.controller';
import { HttpMetricsInterceptor } from './http-metrics.interceptor';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';
import { ObservabilityExceptionFilter } from './observability-exception.filter';
import { ProviderHealthService } from './provider-health.service';
import { SecurityAuditService } from './security-audit.service';
import { ProviderObservability } from './provider-observability';
import { RequestContextMiddleware } from './request-context.middleware';
import { RequestContextService } from './request-context.service';
import { SentryErrorTracker } from './sentry-error-tracker';
import { TracingService } from './tracing.service';

@Global()
@Module({
  controllers: [
    MetricsController,
    ClientTelemetryController,
    DependencyHealthController,
    InternalObservabilityController,
  ],
  providers: [
    RequestContextService,
    TracingService,
    MetricsService,
    ProviderObservability,
    AiObservabilityService,
    ProviderHealthService,
    SecurityAuditService,
    {
      provide: ERROR_TRACKER,
      inject: [ConfigService],
      useFactory: (config: ConfigService<ApiConfig, true>) =>
        SentryErrorTracker.tryCreate({
          dsn: config.get('observability.sentryDsn', { infer: true }),
          environment: config.get('nodeEnv', { infer: true }),
          release: config.get('release', { infer: true }),
          tracesSampleRate: config.get('observability.sentryTracesSampleRate', {
            infer: true,
          }),
        }),
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: HttpMetricsInterceptor,
    },
    {
      provide: APP_FILTER,
      useClass: ObservabilityExceptionFilter,
    },
  ],
  exports: [
    RequestContextService,
    TracingService,
    MetricsService,
    ProviderObservability,
    AiObservabilityService,
    ProviderHealthService,
    SecurityAuditService,
    ERROR_TRACKER,
  ],
})
export class ObservabilityModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('*');
  }
}
