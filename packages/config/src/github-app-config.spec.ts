import { describe, expect, it } from 'vitest';

import {
  apiEnvSchema,
  collectGitHubAppConfigIssues,
  collectProductionSecurityIssues,
} from './index';

function baseProductionEnv(overrides: Record<string, string | undefined> = {}) {
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

describe('GitHub App config validation', () => {
  it('allows fully omitted GitHub App env in production', () => {
    expect(collectGitHubAppConfigIssues(baseProductionEnv())).toEqual([]);
  });

  it('rejects partial GitHub App configuration', () => {
    const issues = collectGitHubAppConfigIssues(
      baseProductionEnv({ GITHUB_APP_ID: '12345', GITHUB_APP_SLUG: 'project-x' }),
    );
    expect(issues.some((i) => i.code === 'GITHUB_APP_PARTIAL_CONFIG')).toBe(true);
  });

  it('accepts full GitHub App configuration', () => {
    const issues = collectGitHubAppConfigIssues(
      baseProductionEnv({
        GITHUB_APP_ID: '12345',
        GITHUB_APP_PRIVATE_KEY:
          '-----BEGIN RSA PRIVATE KEY-----\\nabc\\n-----END RSA PRIVATE KEY-----',
        GITHUB_APP_WEBHOOK_SECRET: 'webhook-secret-16chars',
        GITHUB_APP_SLUG: 'project-x',
      }),
    );
    expect(issues).toEqual([]);
  });

  it('requires OAuth client id/secret pair', () => {
    const issues = collectGitHubAppConfigIssues(
      baseProductionEnv({
        GITHUB_APP_ID: '1',
        GITHUB_APP_PRIVATE_KEY: 'pem',
        GITHUB_APP_WEBHOOK_SECRET: 'webhook-secret-16chars',
        GITHUB_APP_SLUG: 'project-x',
        GITHUB_APP_CLIENT_ID: 'cid',
      }),
    );
    expect(issues.some((i) => i.code === 'GITHUB_APP_OAUTH_PAIR')).toBe(true);
  });

  it('surfaces GitHub App issues via production security collector', () => {
    const env = baseProductionEnv({ GITHUB_APP_ID: '123' });
    const issues = collectProductionSecurityIssues(env);
    expect(issues.some((i) => i.code === 'GITHUB_APP_PARTIAL_CONFIG')).toBe(true);
  });
});
