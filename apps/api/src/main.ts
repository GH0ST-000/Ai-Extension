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

  await app.listen(port, host);
}

void bootstrap();
