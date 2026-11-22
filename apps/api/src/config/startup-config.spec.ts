/**
 * M1 — startup configuration. Exercises the real startup hooks: `validateEnv` (Nest
 * ConfigModule validator, runs before the app boots) and the `configuration()` factory.
 * Placeholder values only; assertions check that error messages never echo secret values.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  apiEnvSchema,
  collectDeploymentWarnings,
  resolveApiHost,
  resolveTrustProxyHops,
} from '@project-x/config';

import { createBillingProvider, PaddleBillingProvider } from '../billing/billing-provider';
import { prismaClientOptions } from '../prisma/prisma.service';

import configuration from './configuration';
import { validateEnv } from './env.validation';

const SECRET_JWT = 'production-jwt-secret-with-enough-entropy-32b';
const SECRET_ENC = 'production-encryption-key-with-entropy-32';
const SECRET_PADDLE = 'paddle-webhook-secret-safe';

const PRODUCTION: Record<string, string> = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/projectx?schema=public',
  OPENAI_API_KEY: 'sk-test-not-real',
  JWT_SECRET: SECRET_JWT,
  TOKEN_ENCRYPTION_KEY: SECRET_ENC,
  AI_CORS_ORIGINS:
    'https://app.projectx-fixture.dev,chrome-extension://abcdefghijklmnopabcdefghijklmnop',
  METRICS_SCRAPE_TOKEN: 'metrics-token-16chars',
  INTERNAL_OBSERVABILITY_TOKEN: 'internal-token-16c',
  HEALTH_DETAILS_TOKEN: 'health-token-16chars',
  PADDLE_ENVIRONMENT: 'production',
  PADDLE_API_KEY: 'live_paddle_api_key_for_tests',
  PADDLE_WEBHOOK_SECRET: SECRET_PADDLE,
  PADDLE_PRICE_PRO_MONTHLY: 'pri_pro_m',
  PADDLE_PRICE_TEAM_MONTHLY: 'pri_team_m',
  APP_BASE_URL: 'https://app.projectx-fixture.dev',
  RESEND_API_KEY: 're_FixtureKey0123456789abcdef',
  MAIL_FROM: 'Project X <no-reply@mail.projectx-fixture.dev>',
  // One reverse proxy in front of the API, stated explicitly (F-26).
  TRUST_PROXY_HOPS: '1',
};
/** What a developer typically has locally: no secrets, everything defaulted. */
const LOCAL: Record<string, string> = {
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/projectx?schema=public',
  OPENAI_API_KEY: 'sk-test-not-real',
};

function without(env: Record<string, string>, ...keys: string[]) {
  const copy = { ...env };
  for (const key of keys) delete copy[key];
  return copy;
}

function startupError(env: Record<string, string | undefined>): string {
  try {
    validateEnv(env);
  } catch (error) {
    const message = (error as Error).message;
    for (const secret of [SECRET_JWT, SECRET_ENC, SECRET_PADDLE]) {
      expect(message).not.toContain(secret); // keys are named, values never printed
    }
    return message;
  }
  throw new Error('expected startup to fail');
}

afterEach(() => vi.unstubAllEnvs());

describe('API startup configuration (M1)', () => {
  it('explicit development starts with local defaults (no secrets needed)', () => {
    expect(() => validateEnv({ ...LOCAL, NODE_ENV: 'development' })).not.toThrow();
  });

  it('explicit test starts with local defaults', () => {
    expect(() => validateEnv({ ...LOCAL, NODE_ENV: 'test' })).not.toThrow();
  });

  it('production with complete, secure configuration starts', () => {
    expect(() => validateEnv(PRODUCTION)).not.toThrow();
  });

  it('NODE_ENV unset fails fast instead of defaulting to development', () => {
    expect(startupError(without(PRODUCTION, 'NODE_ENV'))).toContain(
      'NODE_ENV: NODE_ENV must be set explicitly',
    );
    expect(startupError(LOCAL)).toContain('NODE_ENV must be set explicitly');
  });

  it('an unexpected NODE_ENV value fails fast', () => {
    for (const value of ['staging', 'prod', 'Production', '']) {
      expect(startupError({ ...PRODUCTION, NODE_ENV: value })).toContain(
        'NODE_ENV must be set explicitly',
      );
    }
  });

  it('production without JWT_SECRET (the insecure default) is refused', () => {
    expect(startupError(without(PRODUCTION, 'JWT_SECRET'))).toContain('JWT_SECRET_INSECURE');
  });

  it('production rejects every known insecure secret default', () => {
    for (const value of ['project-x-dev-jwt-secret-change-me', 'changeme-but-long-enough!!']) {
      expect(startupError({ ...PRODUCTION, JWT_SECRET: value })).toContain('JWT_SECRET');
    }
    expect(
      startupError({ ...PRODUCTION, TOKEN_ENCRYPTION_KEY: 'project-x-dev-token-encryption-key' }),
    ).toContain('TOKEN_ENCRYPTION_KEY_REQUIRED');
    expect(startupError({ ...PRODUCTION, PADDLE_WEBHOOK_SECRET: 'dev-webhook-secret' })).toContain(
      'PADDLE_WEBHOOK_SECRET_DEFAULT',
    );
  });

  it('production without TOKEN_ENCRYPTION_KEY is refused (no fallback to JWT_SECRET)', () => {
    expect(startupError(without(PRODUCTION, 'TOKEN_ENCRYPTION_KEY'))).toContain(
      'TOKEN_ENCRYPTION_KEY_REQUIRED',
    );
    expect(startupError({ ...PRODUCTION, TOKEN_ENCRYPTION_KEY: SECRET_JWT })).toContain(
      'TOKEN_ENCRYPTION_KEY_SAME_AS_JWT',
    );
  });

  it('production without PADDLE_WEBHOOK_SECRET is refused', () => {
    expect(startupError(without(PRODUCTION, 'PADDLE_WEBHOOK_SECRET'))).toContain(
      'PADDLE_PRODUCTION_SECRETS',
    );
  });

  it('production CORS must be an explicit allowlist (no wildcard, null or empty list)', () => {
    expect(startupError(without(PRODUCTION, 'AI_CORS_ORIGINS'))).toContain('CORS_ORIGINS_REQUIRED');
    expect(startupError({ ...PRODUCTION, AI_CORS_ORIGINS: '*' })).toContain(
      'CORS_WILDCARD_FORBIDDEN',
    );
    expect(
      startupError({ ...PRODUCTION, AI_CORS_ORIGINS: 'https://app.projectx-fixture.dev,null' }),
    ).toContain('CORS_NULL_ORIGIN_FORBIDDEN');
  });

  it('development served from a public URL may not use the development secrets', () => {
    const exposed = { ...LOCAL, NODE_ENV: 'development', APP_BASE_URL: 'https://beta.example.com' };
    const message = startupError(exposed);
    expect(message).toContain('JWT_SECRET_INSECURE');
    expect(message).toContain('TOKEN_ENCRYPTION_KEY_REQUIRED');
    expect(() =>
      validateEnv({ ...exposed, JWT_SECRET: SECRET_JWT, TOKEN_ENCRYPTION_KEY: SECRET_ENC }),
    ).not.toThrow();
    // Local development keeps working without any secrets.
    expect(() =>
      validateEnv({ ...LOCAL, NODE_ENV: 'development', APP_BASE_URL: 'http://localhost:3000' }),
    ).not.toThrow();
  });

  it('N-6: NODE_ENV=test is no bypass — a public test deployment may not use the development secrets', () => {
    const exposed = { ...LOCAL, NODE_ENV: 'test', APP_BASE_URL: 'https://staging.example.com' };
    const message = startupError(exposed);
    expect(message).toContain('JWT_SECRET_INSECURE');
    expect(message).toContain('TOKEN_ENCRYPTION_KEY_REQUIRED');
    expect(() =>
      validateEnv({ ...exposed, JWT_SECRET: SECRET_JWT, TOKEN_ENCRYPTION_KEY: SECRET_ENC }),
    ).not.toThrow();
  });

  it('N-6: development/test on a network bind with default secrets is warned about; production is not', () => {
    const local = apiEnvSchema.parse({ ...LOCAL, NODE_ENV: 'development', API_HOST: '127.0.0.1' });
    expect(collectDeploymentWarnings(local)).toEqual([]);
    const docker = apiEnvSchema.parse({ ...LOCAL, NODE_ENV: 'development', API_HOST: '0.0.0.0' });
    const warnings = collectDeploymentWarnings(docker);
    expect(warnings.map((w) => w.code)).toEqual(['INSECURE_DEFAULTS_ON_NETWORK_BIND']);
    expect(JSON.stringify(warnings)).not.toContain('project-x-dev-jwt-secret'); // never the value
    const strongSecret = apiEnvSchema.parse({ ...LOCAL, NODE_ENV: 'test', JWT_SECRET: SECRET_JWT });
    expect(collectDeploymentWarnings(strongSecret)).toEqual([]);
  });

  it('INFO: production without an extension origin in AI_CORS_ORIGINS is warned about', () => {
    const withExt = apiEnvSchema.parse(PRODUCTION);
    expect(collectDeploymentWarnings(withExt)).toEqual([]);
    const noExt = apiEnvSchema.parse({
      ...PRODUCTION,
      AI_CORS_ORIGINS: 'https://app.projectx-fixture.dev',
    });
    expect(collectDeploymentWarnings(noExt).map((w) => w.code)).toEqual([
      'EXTENSION_ORIGIN_NOT_CONFIGURED',
    ]);
  });

  it('Decision D: development/test bound EXPLICITLY to a public address refuses the default secrets', () => {
    for (const host of ['203.0.113.10', 'api.example.com', '2001:db8::1', '::ffff:203.0.113.10']) {
      const message = startupError({ ...LOCAL, NODE_ENV: 'development', API_HOST: host });
      expect(message).toContain('JWT_SECRET_INSECURE');
      expect(() => validateEnv({ ...LOCAL, NODE_ENV: 'test', API_HOST: host })).toThrow(
        /JWT_SECRET_INSECURE/,
      );
    }
    // Local/Docker binds keep working (0.0.0.0 only warns), as do private networks.
    for (const host of [
      '127.0.0.1',
      'localhost',
      '0.0.0.0',
      '::',
      '10.0.0.5',
      '192.168.1.20',
      'api',
    ]) {
      expect(() =>
        validateEnv({ ...LOCAL, NODE_ENV: 'development', API_HOST: host }),
      ).not.toThrow();
    }
    // With real secrets an explicit public bind is allowed.
    expect(() =>
      validateEnv({
        ...LOCAL,
        NODE_ENV: 'development',
        API_HOST: '203.0.113.10',
        JWT_SECRET: SECRET_JWT,
        TOKEN_ENCRYPTION_KEY: SECRET_ENC,
      }),
    ).not.toThrow();
  });

  it('Decision 3: development and test default to loopback; production to all interfaces', () => {
    const bind = (env: Record<string, string>) => resolveApiHost(apiEnvSchema.parse(env));
    expect(bind({ ...LOCAL, NODE_ENV: 'development' })).toBe('127.0.0.1');
    expect(bind({ ...LOCAL, NODE_ENV: 'test' })).toBe('127.0.0.1');
    expect(bind(PRODUCTION)).toBe('0.0.0.0');
    // Explicit choices win (the opt-in for Docker / LAN development).
    expect(bind({ ...LOCAL, NODE_ENV: 'development', API_HOST: '127.0.0.1' })).toBe('127.0.0.1');
    expect(bind({ ...LOCAL, NODE_ENV: 'development', API_HOST: '0.0.0.0' })).toBe('0.0.0.0');
    expect(bind({ ...PRODUCTION, API_HOST: '10.0.0.4' })).toBe('10.0.0.4');
    // The resolved address reaches the server configuration.
    vi.stubEnv('NODE_ENV', 'development');
    for (const [k, v] of Object.entries(LOCAL)) vi.stubEnv(k, v);
    vi.stubEnv('API_HOST', '');
    expect(configuration().host).toBe('127.0.0.1');
  });

  it('Decision 3: default local development raises no network-exposure warning; explicit 0.0.0.0 with default secrets does', () => {
    expect(
      collectDeploymentWarnings(apiEnvSchema.parse({ ...LOCAL, NODE_ENV: 'development' })),
    ).toEqual([]);
    const docker = apiEnvSchema.parse({ ...LOCAL, NODE_ENV: 'development', API_HOST: '0.0.0.0' });
    expect(collectDeploymentWarnings(docker).map((w) => w.code)).toEqual([
      'INSECURE_DEFAULTS_ON_NETWORK_BIND',
    ]);
    // Docker development with its own secrets: no warning, starts normally.
    const dockerSecured = {
      ...LOCAL,
      NODE_ENV: 'development',
      API_HOST: '0.0.0.0',
      JWT_SECRET: SECRET_JWT,
      TOKEN_ENCRYPTION_KEY: SECRET_ENC,
    };
    expect(collectDeploymentWarnings(apiEnvSchema.parse(dockerSecured))).toEqual([]);
    expect(() => validateEnv(dockerSecured)).not.toThrow();
  });

  describe('configuration() factory', () => {
    const load = (env: Record<string, string>) => {
      for (const key of Object.keys(PRODUCTION)) vi.stubEnv(key, undefined as never);
      vi.stubEnv('NODE_ENV', undefined as never);
      for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
      return configuration();
    };

    it('local development falls back to JWT_SECRET for token encryption', () => {
      const config = load({ ...LOCAL, NODE_ENV: 'development' });
      expect(config.nodeEnv).toBe('development');
      expect(config.secrets.encryptionKey).toBe(config.jwt.secret);
    });

    it('production uses the dedicated encryption key', () => {
      const config = load(PRODUCTION);
      expect(config.nodeEnv).toBe('production');
      expect(config.secrets.encryptionKey).toBe(SECRET_ENC);
      expect(config.secrets.encryptionKey).not.toBe(config.jwt.secret);
    });

    it('refuses to build a configuration when NODE_ENV is unset', () => {
      expect(() => load(LOCAL)).toThrow(/NODE_ENV must be set explicitly/);
    });
  });
});

/** F-10: the configured TLS requirement must be the connection Prisma actually opens. */
describe('database TLS reaches the client (F-10)', () => {
  const REMOTE = 'postgresql://app:pw@db.internal.example:5432/projectx?schema=public';
  const load = (env: Record<string, string>) => {
    const previous = { ...process.env };
    try {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, env);
      return configuration();
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, previous);
    }
  };

  it('DATABASE_SSL=true changes the URL the Prisma client is constructed with', () => {
    const config = load({ ...PRODUCTION, DATABASE_URL: REMOTE, DATABASE_SSL: 'true' });
    expect(config.databaseUrl).toBe(`${REMOTE}&sslmode=require`);
    expect(prismaClientOptions(config.databaseUrl)).toEqual({
      datasources: { db: { url: `${REMOTE}&sslmode=require` } },
    });
  });

  it.each(['prefer', 'allow', 'disable'])(
    'the flag replaces sslmode=%s (never a silent no-op)',
    (mode) => {
      const config = load({
        ...PRODUCTION,
        DATABASE_URL: `${REMOTE}&sslmode=${mode}`,
        DATABASE_SSL: 'true',
      });
      expect(config.databaseUrl).toBe(`${REMOTE}&sslmode=require`);
    },
  );

  it.each(['prefer', 'allow', 'disable'])(
    'a remote production database with sslmode=%s and no flag is refused at startup',
    (mode) => {
      expect(startupError({ ...PRODUCTION, DATABASE_URL: `${REMOTE}&sslmode=${mode}` })).toContain(
        'DATABASE_URL',
      );
    },
  );

  it('ssl=true alone is not accepted as TLS (it is not a Prisma connection parameter)', () => {
    expect(startupError({ ...PRODUCTION, DATABASE_URL: `${REMOTE}&ssl=true` })).toContain(
      'Remote Postgres',
    );
  });

  it('a stronger mode in the URL is kept; an unverified certificate is a deployment warning', () => {
    const strict = `${REMOTE}&sslmode=require&sslaccept=strict`;
    expect(load({ ...PRODUCTION, DATABASE_URL: strict, DATABASE_SSL: 'true' }).databaseUrl).toBe(
      strict,
    );
    const codes = (url: string) =>
      collectDeploymentWarnings(apiEnvSchema.parse({ ...PRODUCTION, DATABASE_URL: url })).map(
        (w) => w.code,
      );
    expect(codes(`${REMOTE}&sslmode=require`)).toContain('DATABASE_TLS_CERTIFICATE_NOT_VERIFIED');
    expect(codes(strict)).not.toContain('DATABASE_TLS_CERTIFICATE_NOT_VERIFIED');
  });

  it('never puts the database URL (credentials) in a startup error', () => {
    const message = startupError({ ...PRODUCTION, DATABASE_URL: `${REMOTE}&sslmode=disable` });
    expect(message).not.toContain('app:pw');
    expect(message).not.toContain('db.internal.example');
  });
});

/** F-26: the number of trusted proxy hops is configuration, not a constant. */
describe('trusted proxy hops (F-26)', () => {
  const hops = (env: Record<string, string>) => resolveTrustProxyHops(apiEnvSchema.parse(env));
  it('defaults: 1 in production, 0 locally; explicit values win', () => {
    expect(hops(without(PRODUCTION, 'TRUST_PROXY_HOPS'))).toBe(1);
    expect(hops({ ...LOCAL, NODE_ENV: 'development' })).toBe(0);
    expect(hops({ ...PRODUCTION, TRUST_PROXY_HOPS: '0' })).toBe(0);
    expect(hops({ ...PRODUCTION, TRUST_PROXY_HOPS: '2' })).toBe(2);
  });
  it.each(['true', '-1', '9', 'all', '1.5'])('rejects %s (never "trust everything")', (value) => {
    expect(() => apiEnvSchema.parse({ ...PRODUCTION, TRUST_PROXY_HOPS: value })).toThrow();
  });
  it('production without an explicit value warns the operator', () => {
    const codes = (env: Record<string, string>) =>
      collectDeploymentWarnings(apiEnvSchema.parse(env)).map((w) => w.code);
    expect(codes(without(PRODUCTION, 'TRUST_PROXY_HOPS'))).toContain('TRUST_PROXY_HOPS_NOT_SET');
    expect(codes(PRODUCTION)).not.toContain('TRUST_PROXY_HOPS_NOT_SET');
    expect(codes({ ...PRODUCTION, TRUST_PROXY_HOPS: '2' })).not.toContain(
      'TRUST_PROXY_HOPS_NOT_SET',
    );
  });
});

/** Staging: production hardening with sandbox billing — and only sandbox billing. */
describe('APP_STAGE=staging', () => {
  const STAGING: Record<string, string> = {
    ...PRODUCTION,
    APP_STAGE: 'staging',
    PADDLE_ENVIRONMENT: 'sandbox',
    PADDLE_API_KEY: 'pdl_sdbx_apikey_fixture_0123456789',
  };

  it('starts with Paddle sandbox and uses the REAL Paddle provider (no development shortcuts)', () => {
    expect(() => validateEnv(STAGING)).not.toThrow();
    const provider = createBillingProvider({
      nodeEnv: 'production',
      deploymentStage: 'staging',
      paddle: {
        environment: 'sandbox',
        apiKey: STAGING.PADDLE_API_KEY!,
        webhookSecret: SECRET_PADDLE,
        clientToken: '',
        prices: { proMonthly: 'p', proYearly: '', teamMonthly: 't', teamYearly: '' },
      },
    });
    expect(provider).toBeInstanceOf(PaddleBillingProvider);
    // The development webhook secret and the bare-HMAC legacy signature are not accepted.
    const body = Buffer.from('{"event_id":"e","event_type":"subscription.updated"}');
    expect(provider.verifyWebhook(body, 'sha256=deadbeef')).toBe(false);
  });

  it('refuses live Paddle in staging (no accidental real charges)', () => {
    expect(startupError({ ...STAGING, PADDLE_ENVIRONMENT: 'production' })).toContain('staging');
    expect(
      startupError({ ...STAGING, PADDLE_API_KEY: 'pdl_live_apikey_fixture_0123456789' }),
    ).toContain('PADDLE_API_KEY');
    expect(() =>
      createBillingProvider({
        nodeEnv: 'production',
        deploymentStage: 'staging',
        paddle: {
          environment: 'production',
          apiKey: 'k',
          webhookSecret: SECRET_PADDLE,
          clientToken: '',
          prices: { proMonthly: '', proYearly: '', teamMonthly: '', teamYearly: '' },
        },
      }),
    ).toThrow(/staging/);
  });

  it('production itself still refuses the sandbox', () => {
    expect(startupError({ ...PRODUCTION, PADDLE_ENVIRONMENT: 'sandbox' })).toContain('sandbox');
  });

  it.each([
    ['JWT_SECRET', { JWT_SECRET: 'project-x-dev-jwt-secret-change-me' }],
    ['TOKEN_ENCRYPTION_KEY', { TOKEN_ENCRYPTION_KEY: '' }],
    ['AI_CORS_ORIGINS', { AI_CORS_ORIGINS: '' }],
    ['PADDLE_WEBHOOK_SECRET', { PADDLE_WEBHOOK_SECRET: 'dev-webhook-secret' }],
    ['METRICS_SCRAPE_TOKEN', { METRICS_SCRAPE_TOKEN: '' }],
    ['APP_BASE_URL', { APP_BASE_URL: 'http://localhost:3000' }],
    ['RESEND_API_KEY', { RESEND_API_KEY: '' }],
    ['Remote Postgres', { DATABASE_URL: 'postgresql://a:b@db.example.com:5432/x' }],
    ['REDIS', { REDIS_HOST: 'redis.example.com' }],
  ])('staging keeps the production requirement for %s', (needle, override) => {
    expect(startupError({ ...STAGING, ...override })).toContain(needle);
  });

  it('APP_STAGE does nothing outside production (development is never "hardened" by a label)', () => {
    const config = (() => {
      const previous = { ...process.env };
      try {
        for (const key of Object.keys(process.env)) delete process.env[key];
        Object.assign(process.env, { ...LOCAL, NODE_ENV: 'development', APP_STAGE: 'staging' });
        return configuration();
      } finally {
        for (const key of Object.keys(process.env)) delete process.env[key];
        Object.assign(process.env, previous);
      }
    })();
    expect(config.deploymentStage).toBe('local');
  });
});
