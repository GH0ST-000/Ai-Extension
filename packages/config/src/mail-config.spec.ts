import { describe, expect, it } from 'vitest';

import {
  apiEnvSchema,
  collectMailConfigIssues,
  collectProductionSecurityIssues,
  isValidMailFrom,
} from './index';

function env(overrides: Record<string, string | undefined> = {}) {
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

const codes = (issues: { code: string }[]) => issues.map((issue) => issue.code);

describe('mail configuration (Resend)', () => {
  it('both empty is valid: email disabled', () => {
    expect(collectMailConfigIssues(env())).toEqual([]);
    expect(codes(collectProductionSecurityIssues(env()))).not.toContain('MAIL_CONFIG_PAIR');
  });

  it('key and sender must be set together; the sender must be an address', () => {
    expect(codes(collectMailConfigIssues(env({ RESEND_API_KEY: 're_x' })))).toContain(
      'MAIL_CONFIG_PAIR',
    );
    expect(
      codes(collectMailConfigIssues(env({ MAIL_FROM: 'Project X <no-reply@mail.example.com>' }))),
    ).toContain('MAIL_CONFIG_PAIR');
    expect(
      codes(collectMailConfigIssues(env({ RESEND_API_KEY: 're_x', MAIL_FROM: 'not an address' }))),
    ).toContain('MAIL_FROM_INVALID');
    for (const from of ['no-reply@mail.example.com', 'Project X <no-reply@mail.example.com>']) {
      expect(collectMailConfigIssues(env({ RESEND_API_KEY: 're_x', MAIL_FROM: from }))).toEqual([]);
    }
  });

  it('a half configuration blocks production startup, not development', () => {
    expect(codes(collectProductionSecurityIssues(env({ RESEND_API_KEY: 're_x' })))).toContain(
      'MAIL_CONFIG_PAIR',
    );
    expect(
      collectProductionSecurityIssues(env({ NODE_ENV: 'development', RESEND_API_KEY: 're_x' })),
    ).toEqual([]);
  });

  it('MAIL_FROM parsing: accepts address / Name <address>, rejects malformed values', () => {
    for (const ok of [
      'no-reply@mail.example.com',
      'Project X <no-reply@mail.example.com>',
      '"Project X" <no-reply@example.co.uk>',
    ]) {
      expect(isValidMailFrom(ok), ok).toBe(true);
    }
    for (const bad of [
      '',
      'not an address',
      'Project X <no-reply@example>',
      'no-reply@example',
      'a@b@c.com',
      '@example.com',
      'user@.example.com',
      'user@example..com',
      'user@example.com.',
      'Project X no-reply@example.com>',
      'Name <user name@example.com>',
      'Name <<user@example.com>',
    ]) {
      expect(isValidMailFrom(bad), bad).toBe(false);
    }
  });

  it('MAIL_FROM parsing is linear: adversarial input is rejected immediately', () => {
    for (const attack of [`<!@!.${'!.'.repeat(50_000)}`, `!@!.${'!.'.repeat(50_000)}`]) {
      const started = performance.now();
      isValidMailFrom(attack);
      expect(performance.now() - started).toBeLessThan(100);
    }
  });
});
