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
    PADDLE_ENVIRONMENT: 'sandbox',
    PADDLE_WEBHOOK_SECRET: 'paddle-webhook-secret-safe',
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

  it('does not fail development defaults', () => {
    const env = apiEnvSchema.parse({
      DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/projectx?schema=public',
      OPENAI_API_KEY: 'sk-test',
      NODE_ENV: 'development',
    });
    expect(collectProductionSecurityIssues(env)).toEqual([]);
  });
});
