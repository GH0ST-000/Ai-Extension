import { describe, expect, it } from 'vitest';

import { redisConnectionOptions } from './redis-connection';

describe('redisConnectionOptions (N-5)', () => {
  it('REDIS_TLS=true → TLS with certificate verification (never disabled)', () => {
    const options = redisConnectionOptions({
      host: 'r.example',
      port: 6380,
      password: 'p',
      tls: true,
    });
    expect(options.tls).toEqual({});
    expect(JSON.stringify(options)).not.toContain('rejectUnauthorized');
    expect(options).toMatchObject({ host: 'r.example', port: 6380, password: 'p' });
  });

  it('local development without TLS keeps working (plain connection)', () => {
    const options = redisConnectionOptions({ host: '127.0.0.1', port: 6379, tls: false });
    expect(options.tls).toBeUndefined();
    expect(options.password).toBeUndefined();
  });

  it('request-path commands fail fast; only BullMQ retries forever (adversarial N2)', () => {
    const commands = redisConnectionOptions({ host: 'h', port: 1 }, 'commands');
    expect(commands.maxRetriesPerRequest).toBe(2);
    expect(commands.commandTimeout).toBeGreaterThan(0);
    expect(redisConnectionOptions({ host: 'h', port: 1 }, 'queue').maxRetriesPerRequest).toBeNull();
  });

  it('the BullMQ connection is built by the same function as RedisService', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const appModule = readFileSync(join(__dirname, '..', 'app.module.ts'), 'utf8');
    const service = readFileSync(join(__dirname, 'redis.service.ts'), 'utf8');
    expect(appModule).toMatch(/connection: redisConnectionOptions\(/);
    expect(appModule).toMatch(/tls: config\.get<boolean>\('redis\.tls'\) === true/);
    expect(service).toMatch(/redisConnectionOptions\(redis, 'commands'\)/);
  });
});
