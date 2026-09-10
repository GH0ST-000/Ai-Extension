import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';

import { AppModule } from './app.module';
import type { ApiConfig } from './config/configuration';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

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
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  await app.listen(port, host);
}

void bootstrap();
