import type { RedisOptions } from 'ioredis';

export type RedisSettings = {
  host: string;
  port: number;
  password?: string;
  tls?: boolean;
};

/**
 * N-5: the ONE place that turns Redis settings into connection options, used by every Redis
 * connection (RedisService: cache, rate limits, locks; BullMQ queue producers and workers), so
 * REDIS_TLS can never be honored by one and ignored by another. TLS uses Node's defaults —
 * certificate verification stays ON (no `rejectUnauthorized: false`, ever).
 */
export function redisConnectionOptions(
  settings: RedisSettings,
  purpose: 'queue' | 'commands' = 'queue',
): RedisOptions {
  return {
    host: settings.host,
    port: settings.port,
    password: settings.password || undefined,
    ...(settings.tls ? { tls: {} } : {}),
    ...(purpose === 'queue'
      ? // BullMQ requires blocking connections that retry forever.
        { maxRetriesPerRequest: null }
      : // Request-path commands (rate limits, caches, locks) must fail fast while Redis is
        // down so callers use their fallbacks instead of hanging (adversarial review N2).
        { maxRetriesPerRequest: 2, commandTimeout: COMMAND_TIMEOUT_MS }),
  };
}

/** Upper bound for one request-path Redis command. */
export const COMMAND_TIMEOUT_MS = 2_000;
