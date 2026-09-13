import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger as NestLogger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { json, urlencoded, type Request, type Response, type NextFunction } from 'express';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import type { ApiConfig } from './config/configuration';
import { ERROR_TRACKER, type ErrorTracker } from './observability/error-tracker';

const DEV_DASHBOARD_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3001',
] as const;

function applySecurityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  );
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  next();
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
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

  // Bound JSON bodies — webhooks still receive rawBody via Nest rawBody option + json verify.
  app.use(
    json({
      limit: jsonBodyLimitBytes,
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use(urlencoded({ extended: true, limit: Math.min(jsonBodyLimitBytes, 256_000) }));
  app.use(applySecurityHeaders);

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

  const productionAllowlist = new Set([...configuredOrigins, ...contentScriptOrigins]);
  const developmentAllowlist = new Set([
    ...DEV_DASHBOARD_ORIGINS,
    ...configuredOrigins,
    ...contentScriptOrigins,
  ]);

  app.enableCors({
    origin: (origin, callback) => {
      // Non-browser clients (curl, server-to-server, webhooks) send no Origin.
      if (!origin) {
        callback(null, true);
        return;
      }

      if (nodeEnv !== 'production') {
        // Dev: dashboard localhost + configured origins. Still reject obvious wildcards.
        if (origin === '*' || origin === 'null') {
          callback(null, false);
          return;
        }
        if (developmentAllowlist.has(origin) || configuredOrigins.length === 0) {
          // When no AI_CORS_ORIGINS configured in dev, allow any origin so content scripts work.
          callback(null, true);
          return;
        }
        callback(null, developmentAllowlist.has(origin));
        return;
      }

      // Production: exact allowlist only — never substring match, never chrome-extension://*
      callback(null, productionAllowlist.has(origin));
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
    maxAge: 600,
  });

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
