import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

import type { ApiConfig } from '../config/configuration';
import { redisConnectionOptions } from './redis-connection';

@Injectable()
export class RedisService extends Redis implements OnModuleDestroy {
  constructor(config: ConfigService<ApiConfig, true>) {
    const redis = config.get('redis', { infer: true });

    super({ ...redisConnectionOptions(redis, 'commands'), lazyConnect: true });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.status === 'ready' || this.status === 'connecting') {
      await this.quit();
    }
  }
}
