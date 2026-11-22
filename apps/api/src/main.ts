import { NestFactory } from '@nestjs/core';
import { Logger as NestLogger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { apiEnvSchema, collectDeploymentWarnings } from '@project-x/config';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import type { ApiConfig } from './config/configuration';
import { ERROR_TRACKER, type ErrorTracker } from './observability/error-tracker';
import { configureHttpApp } from './common/http/configure-app';
import type { NestExpressApplication } from '@nestjs/platform-express';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    rawBody: true,
    bodyParser: false,
  });

  const config = app.get(ConfigService<ApiConfig, true>);
  const host = config.get('host', { infer: true });
  const port = config.get('port', { infer: true });
  const nodeEnv = config.get('nodeEnv', { infer: true });
  const configuredOrigins = config.get('ai.corsOrigins', { infer: true });
  const contentScriptOrigins = config.get('ai.corsContentScriptOrigins', { infer: true });
  const jsonBodyLimitBytes = config.get('jsonBodyLimitBytes', { infer: true });
  const release = config.get('release', { infer: true });
  const service = config.get('service', { infer: true });
  const obs = config.get('observability', { infer: true });

  // Body parsing, cookie CSRF, security headers, proxy trust, validation, the /api prefix and
  // CORS: one function, shared with the HTTP security tests (src/common/http/configure-app.ts).
  configureHttpApp(app, {
    nodeEnv,
    configuredOrigins,
    contentScriptOrigins,
    jsonBodyLimitBytes,
    trustProxyHops: config.get('trustProxyHops', { infer: true }),
  });

  app.useLogger(app.get(Logger));
  // N-6: non-fatal deployment warnings (key names only, never values).
  for (const warning of collectDeploymentWarnings(apiEnvSchema.parse(process.env))) {
    app
      .get(Logger)
      .warn({ msg: 'startup.deployment_warning', code: warning.code, detail: warning.message });
  }
  app.enableShutdownHooks();

  const productionAllowlist = new Set([...configuredOrigins, ...contentScriptOrigins]);

  const bootstrapLogger = new NestLogger('Bootstrap');
  bootstrapLogger.log({
    msg: 'service.started',
    event: 'service.started',
    service,
    environment: nodeEnv,
    release,
    nodeVersion: process.version,
    paddleConfigured: Boolean(config.get('paddle.webhookSecret', { infer: true })),
    sentryConfigured: Boolean(obs.sentryDsn),
    metricsTokenConfigured: Boolean(obs.metricsScrapeToken),
    corsOriginCount: productionAllowlist.size,
  });

  const errorTracker = app.get<ErrorTracker>(ERROR_TRACKER);

  const shutdown = async (signal: string) => {
    bootstrapLogger.log({
      msg: 'service.shutdown.start',
      event: 'service.shutdown.start',
      signal,
    });
    try {
      await errorTracker.flush(2000);
    } catch {
      // bounded flush — never hang forever
    }
    await app.close();
    bootstrapLogger.log({
      msg: 'service.shutdown.complete',
      event: 'service.shutdown.complete',
    });
  };

  process.once('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.once('SIGINT', () => {
    void shutdown('SIGINT');
  });

  await app.listen(port, host);
}

void bootstrap();
