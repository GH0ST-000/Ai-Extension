import { Injectable } from '@nestjs/common';
import { HealthIndicator, type HealthIndicatorResult, HealthCheckError } from '@nestjs/terminus';

import { RedisService } from '../../redis/redis.service';

@Injectable()
export class RedisHealthIndicator extends HealthIndicator {
  constructor(private readonly redis: RedisService) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    try {
      if (this.redis.status !== 'ready') {
        await this.redis.connect();
      }

      const pong = await this.redis.ping();
      const isHealthy = pong === 'PONG';

      if (!isHealthy) {
        throw new Error(`Unexpected Redis ping response: ${pong}`);
      }

      return this.getStatus(key, true);
    } catch (error) {
      throw new HealthCheckError(
        'Redis check failed',
        this.getStatus(key, false, {
          message: error instanceof Error ? error.message : 'Unknown Redis error',
        }),
      );
    }
  }
}
