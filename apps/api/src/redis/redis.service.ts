import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

import type { ApiConfig } from '../config/configuration';

@Injectable()
export class RedisService extends Redis implements OnModuleDestroy {
  constructor(config: ConfigService<ApiConfig, true>) {
    const redis = config.get('redis', { infer: true });

    super({
      host: redis.host,
      port: redis.port,
      password: redis.password || undefined,
      lazyConnect: true,
      maxRetriesPerRequest: null,
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.status === 'ready' || this.status === 'connecting') {
      await this.quit();
    }
  }
}
