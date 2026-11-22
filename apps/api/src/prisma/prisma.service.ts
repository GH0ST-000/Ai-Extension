import { Injectable, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';

import type { ApiConfig } from '../config/configuration';

/**
 * F-10: the client connects with the EFFECTIVE database URL from configuration
 * (`databaseUrl`: DATABASE_URL with DATABASE_SSL applied), not with the raw environment
 * variable the Prisma schema names. Before this, `DATABASE_SSL=true` satisfied the production
 * TLS check while the connection itself was opened without it.
 *
 * Without a ConfigService (unit tests that construct the service directly) the schema's
 * `env("DATABASE_URL")` applies, as before.
 */
export function prismaClientOptions(
  databaseUrl: string | undefined,
): { datasources: { db: { url: string } } } | Record<string, never> {
  return databaseUrl ? { datasources: { db: { url: databaseUrl } } } : {};
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(@Optional() config?: ConfigService<ApiConfig, true>) {
    super(prismaClientOptions(config?.get('databaseUrl', { infer: true })));
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
