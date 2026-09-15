import { describe, expect, it } from 'vitest';
import { apiEnvSchema, collectProductionSecurityIssues, type ApiEnv } from '@project-x/config';

function baseEnv(overrides: Partial<ApiEnv> = {}): ApiEnv {
  return apiEnvSchema.parse({
    DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/projectx?schema=public',
    OPENAI_API_KEY: 'sk-test-not-real',
    NODE_ENV: 'production',
    JWT_SECRET: 'production-jwt-secret-with-enough-entropy-32b',
    TOKEN_ENCRYPTION_KEY: 'production-encryption-key-with-entropy-32',
    AI_CORS_ORIGINS: 'https://app.example.com,chrome-extension://abcdefghijklmnopqrstuvwxyz123456',
    METRICS_SCRAPE_TOKEN: 'metrics-token-16chars',
    INTERNAL_OBSERVABILITY_TOKEN: 'internal-token-16c',
    HEALTH_DETAILS_TOKEN: 'health-token-16chars',
    PADDLE_ENVIRONMENT: 'production',
    PADDLE_API_KEY: 'live_paddle_api_key_for_tests',
    PADDLE_WEBHOOK_SECRET: 'paddle-webhook-secret-safe',
    PADDLE_PRICE_PRO_MONTHLY: 'pri_pro_m',
    PADDLE_PRICE_TEAM_MONTHLY: 'pri_team_m',
    APP_BASE_URL: 'https://app.example.com',
    ...overrides,
  });
}

describe('production security config', () => {
  it('accepts a hardened production configuration', () => {
    expect(collectProductionSecurityIssues(baseEnv())).toEqual([]);
  });

  it('rejects default JWT secret', () => {
    const issues = collectProductionSecurityIssues(
      baseEnv({ JWT_SECRET: 'project-x-dev-jwt-secret-change-me' }),
    );
    expect(issues.some((i) => i.code === 'JWT_SECRET_INSECURE')).toBe(true);
  });

  it('rejects missing TOKEN_ENCRYPTION_KEY', () => {
    const issues = collectProductionSecurityIssues(baseEnv({ TOKEN_ENCRYPTION_KEY: undefined }));
    expect(issues.some((i) => i.code === 'TOKEN_ENCRYPTION_KEY_REQUIRED')).toBe(true);
  });

  it('rejects wildcard CORS', () => {
    const issues = collectProductionSecurityIssues(baseEnv({ AI_CORS_ORIGINS: '*' }));
    expect(issues.some((i) => i.code === 'CORS_WILDCARD_FORBIDDEN')).toBe(true);
  });

  it('rejects empty CORS allowlist', () => {
    const issues = collectProductionSecurityIssues(baseEnv({ AI_CORS_ORIGINS: '' }));
    expect(issues.some((i) => i.code === 'CORS_ORIGINS_REQUIRED')).toBe(true);
  });

  it('rejects sandbox paddle environment in production', () => {
    const issues = collectProductionSecurityIssues(baseEnv({ PADDLE_ENVIRONMENT: 'sandbox' }));
    expect(issues.some((i) => i.code === 'PADDLE_SANDBOX_IN_PRODUCTION')).toBe(true);
  });

  it('rejects production paddle without secrets', () => {
    const issues = collectProductionSecurityIssues(
      baseEnv({
        PADDLE_ENVIRONMENT: 'production',
        PADDLE_API_KEY: '',
        PADDLE_WEBHOOK_SECRET: '',
        PADDLE_PRICE_PRO_MONTHLY: 'pri_pro',
        PADDLE_PRICE_TEAM_MONTHLY: 'pri_team',
      }),
    );
    expect(issues.some((i) => i.code === 'PADDLE_PRODUCTION_SECRETS')).toBe(true);
  });

  it('rejects remote Redis without TLS in production', () => {
    const issues = collectProductionSecurityIssues(
      baseEnv({
        REDIS_HOST: 'redis.prod.example.com',
        REDIS_PASSWORD: 'redis-secret-password',
        REDIS_TLS: false,
      }),
    );
    expect(issues.some((i) => i.code === 'REDIS_REMOTE_WITHOUT_TLS')).toBe(true);
  });

  it('rejects remote Postgres without SSL in production', () => {
    const issues = collectProductionSecurityIssues(
      baseEnv({
        DATABASE_URL: 'postgresql://user:pass@db.prod.example.com:5432/projectx?schema=public',
        DATABASE_SSL: false,
      }),
    );
    expect(issues.some((i) => i.code === 'DATABASE_REMOTE_WITHOUT_SSL')).toBe(true);
  });

  it('accepts remote Postgres when DATABASE_SSL is enabled', () => {
    const issues = collectProductionSecurityIssues(
      baseEnv({
        DATABASE_URL: 'postgresql://user:pass@db.prod.example.com:5432/projectx?schema=public',
        DATABASE_SSL: true,
        REDIS_HOST: 'redis.prod.example.com',
        REDIS_PASSWORD: 'redis-secret-password',
        REDIS_TLS: true,
      }),
    );
    expect(
      issues.filter((i) => i.code.startsWith('REDIS_') || i.code.startsWith('DATABASE_')),
    ).toEqual([]);
  });

  it('rejects partial GitHub App env in production', () => {
    const issues = collectProductionSecurityIssues(baseEnv({ GITHUB_APP_ID: '12345' }));
    expect(issues.some((i) => i.code === 'GITHUB_APP_PARTIAL_CONFIG')).toBe(true);
  });

  it('does not fail development defaults', () => {
    const env = apiEnvSchema.parse({
      DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/projectx?schema=public',
      OPENAI_API_KEY: 'sk-test',
      NODE_ENV: 'development',
    });
    expect(collectProductionSecurityIssues(env)).toEqual([]);
  });
});
