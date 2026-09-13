import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger as NestLogger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import type { ApiConfig } from './config/configuration';
import { ERROR_TRACKER, type ErrorTracker } from './observability/error-tracker';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    rawBody: true,
  });

  app.useLogger(app.get(Logger));
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();

  const config = app.get(ConfigService<ApiConfig, true>);
  const host = config.get('host', { infer: true });
  const port = config.get('port', { infer: true });
  const nodeEnv = config.get('nodeEnv', { infer: true });
  const configuredOrigins = config.get('ai.corsOrigins', { infer: true });
  const release = config.get('release', { infer: true });
  const service = config.get('service', { infer: true });
  const obs = config.get('observability', { infer: true });

  const defaultDevOrigins = [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:3001',
    'http://127.0.0.1:3001',
  ];

  app.enableCors({
    origin: (origin, callback) => {
      // Non-browser clients (curl, server-to-server) send no Origin.
      if (!origin) {
        callback(null, true);
        return;
      }

      // Content scripts inherit the host page Origin (e.g. https://github.com),
      // not chrome-extension://. Allow any origin in non-production so the
      // extension can call the local API from arbitrary pages during development.
      if (nodeEnv !== 'production') {
        callback(null, true);
        return;
      }

      const allowed =
        configuredOrigins.includes(origin) ||
        defaultDevOrigins.includes(origin) ||
        origin.startsWith('chrome-extension://');

      callback(null, allowed);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Workspace-Id',
      'X-Request-Id',
      'Paddle-Signature',
    ],
    exposedHeaders: ['X-Request-Id'],
  });

  const bootstrapLogger = new NestLogger('Bootstrap');
  bootstrapLogger.log({
    msg: 'service.started',
    event: 'service.started',
    service,
    environment: nodeEnv,
    release,
    nodeVersion: process.version,
    paddleConfigured: Boolean(obs && config.get('paddle.webhookSecret', { infer: true })),
    sentryConfigured: Boolean(obs.sentryDsn),
    metricsTokenConfigured: Boolean(obs.metricsScrapeToken),
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
