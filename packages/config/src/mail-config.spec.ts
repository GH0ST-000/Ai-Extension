import { describe, expect, it } from 'vitest';

import {
  apiEnvSchema,
  collectMailConfigIssues,
  collectProductionSecurityIssues,
  collectProductionMailIssues,
  collectProductionSecurityIssues as productionIssues,
  isValidMailFrom,
  looksLikePlaceholder,
} from './index';

function env(overrides: Record<string, string | undefined> = {}) {
  return apiEnvSchema.parse({
    DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/projectx?schema=public',
    OPENAI_API_KEY: 'sk-test-not-real',
    NODE_ENV: 'production',
    JWT_SECRET: 'production-jwt-secret-with-enough-entropy-32b',
    TOKEN_ENCRYPTION_KEY: 'production-encryption-key-with-entropy-32',
    AI_CORS_ORIGINS:
      'https://app.projectx-fixture.dev,chrome-extension://abcdefghijklmnopqrstuvwxyz123456',
    METRICS_SCRAPE_TOKEN: 'metrics-token-16chars',
    INTERNAL_OBSERVABILITY_TOKEN: 'internal-token-16c',
    HEALTH_DETAILS_TOKEN: 'health-token-16chars',
    PADDLE_ENVIRONMENT: 'production',
    PADDLE_API_KEY: 'live_paddle_api_key_for_tests',
    PADDLE_WEBHOOK_SECRET: 'paddle-webhook-secret-safe',
    PADDLE_PRICE_PRO_MONTHLY: 'pri_pro_m',
    PADDLE_PRICE_TEAM_MONTHLY: 'pri_team_m',
    APP_BASE_URL: 'https://app.projectx-fixture.dev',
    RESEND_API_KEY: 're_FixtureKey0123456789abcdef',
    MAIL_FROM: 'Project X <no-reply@mail.projectx-fixture.dev>',
    ...overrides,
  });
}

const NO_MAIL = { RESEND_API_KEY: '', MAIL_FROM: '' };

const codes = (issues: { code: string }[]) => issues.map((issue) => issue.code);

describe('mail configuration (Resend)', () => {
  it('both empty is valid: email disabled', () => {
    expect(collectMailConfigIssues(env(NO_MAIL))).toEqual([]);
    expect(codes(collectProductionSecurityIssues(env(NO_MAIL)))).not.toContain('MAIL_CONFIG_PAIR');
  });

  it('key and sender must be set together; the sender must be an address', () => {
    expect(codes(collectMailConfigIssues(env({ ...NO_MAIL, RESEND_API_KEY: 're_x' })))).toContain(
      'MAIL_CONFIG_PAIR',
    );
    expect(
      codes(
        collectMailConfigIssues(
          env({ ...NO_MAIL, MAIL_FROM: 'Project X <no-reply@mail.example.com>' }),
        ),
      ),
    ).toContain('MAIL_CONFIG_PAIR');
    expect(
      codes(
        collectMailConfigIssues(
          env({ ...NO_MAIL, RESEND_API_KEY: 're_x', MAIL_FROM: 'not an address' }),
        ),
      ),
    ).toContain('MAIL_FROM_INVALID');
    for (const from of ['no-reply@mail.example.com', 'Project X <no-reply@mail.example.com>']) {
      expect(
        collectMailConfigIssues(env({ ...NO_MAIL, RESEND_API_KEY: 're_x', MAIL_FROM: from })),
      ).toEqual([]);
    }
  });

  it('a half configuration blocks production startup, not development', () => {
    expect(
      codes(collectProductionSecurityIssues(env({ ...NO_MAIL, RESEND_API_KEY: 're_x' }))),
    ).toContain('MAIL_CONFIG_PAIR');
    expect(
      collectProductionSecurityIssues(
        env({ ...NO_MAIL, NODE_ENV: 'development', RESEND_API_KEY: 're_x' }),
      ),
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

  describe('Decision 2: production requires a usable mail configuration', () => {
    const prodCodes = (o: Record<string, string | undefined>) => codes(productionIssues(env(o)));

    it('a valid production configuration passes', () => {
      expect(collectProductionMailIssues(env())).toEqual([]);
      expect(productionIssues(env())).toEqual([]);
    });

    it('missing API key or sender blocks production startup', () => {
      expect(prodCodes({ RESEND_API_KEY: '' })).toContain('MAIL_API_KEY_REQUIRED');
      expect(prodCodes({ RESEND_API_KEY: '   ' })).toContain('MAIL_API_KEY_REQUIRED');
      expect(prodCodes({ MAIL_FROM: '' })).toContain('MAIL_FROM_REQUIRED');
      expect(prodCodes(NO_MAIL)).toEqual(
        expect.arrayContaining(['MAIL_API_KEY_REQUIRED', 'MAIL_FROM_REQUIRED']),
      );
    });

    it('placeholder or malformed API keys are rejected, and the value is never echoed', () => {
      for (const key of [
        're_your_api_key_here',
        'changeme',
        '<RESEND_API_KEY>',
        're_short',
        'sk_live_0123456789abcdefghij',
        're_xxxxxxxxxxxxxxxxxxxxxx',
      ]) {
        const issues = productionIssues(env({ RESEND_API_KEY: key }));
        expect(codes(issues)).toContain('MAIL_API_KEY_INVALID');
        expect(JSON.stringify(issues)).not.toContain(key);
      }
    });

    it('invalid or template senders are rejected', () => {
      expect(prodCodes({ MAIL_FROM: 'not an address' })).toContain('MAIL_FROM_INVALID');
      expect(prodCodes({ MAIL_FROM: 'no-reply@localhost' })).toContain('MAIL_FROM_INVALID');
      for (const from of [
        'Project X <no-reply@mail.your-domain.example>', // .env.example template
        'no-reply@example.com',
        'no-reply@mail.example.org',
        'no-reply@projectx.test',
      ]) {
        expect(prodCodes({ MAIL_FROM: from })).toContain('MAIL_FROM_PLACEHOLDER');
      }
    });

    it('APP_BASE_URL must be a public https origin', () => {
      for (const url of [
        'http://app.projectx-fixture.dev', // http in production
        'https://localhost:3000',
        'https://127.0.0.1',
        'https://10.0.0.5',
        'https://[::1]',
        'https://app.example.com',
        'https://app.your-domain.com',
        'https://user:pass@app.projectx-fixture.dev',
        'https://app.projectx-fixture.dev/?next=/x',
        'https://intranet',
      ]) {
        expect(prodCodes({ APP_BASE_URL: url })).toContain('APP_BASE_URL_NOT_PUBLIC_HTTPS');
      }
      expect(prodCodes({ APP_BASE_URL: 'https://app.projectx-fixture.dev/' })).toEqual([]);
    });

    it('development and test start without any mail credentials', () => {
      for (const NODE_ENV of ['development', 'test']) {
        expect(
          productionIssues(env({ ...NO_MAIL, NODE_ENV, APP_BASE_URL: 'http://localhost:3000' })),
        ).toEqual([]);
      }
    });

    it('adversarial review N3/N5: sandbox sender, fake keys and private hosts rejected; real domains accepted', () => {
      expect(prodCodes({ MAIL_FROM: 'onboarding@resend.dev' })).toContain('MAIL_FROM_SANDBOX');
      expect(prodCodes({ MAIL_FROM: 'X <a@send.resend.dev>' })).toContain('MAIL_FROM_SANDBOX');
      for (const key of [
        're_fake_key_123456789',
        're_0000000000000000',
        're_aaaaaaaaaaaaaaaaaaaa',
      ]) {
        expect(prodCodes({ RESEND_API_KEY: key })).toContain('MAIL_API_KEY_INVALID');
      }
      for (const url of [
        'https://app.internal',
        'https://app.corp.internal',
        'https://router.home.arpa',
        'https://100.64.1.2',
      ]) {
        expect(prodCodes({ APP_BASE_URL: url })).toContain('APP_BASE_URL_NOT_PUBLIC_HTTPS');
      }
      for (const domain of [
        'todoist.com',
        'yourbank.com',
        'counterexample.org',
        'replacement-parts.com',
        'change.org',
      ]) {
        expect(
          prodCodes({
            APP_BASE_URL: `https://app.${domain}`,
            MAIL_FROM: `no-reply@mail.${domain}`,
          }),
        ).toEqual([]);
      }
    });

    it('placeholder detection', () => {
      expect(looksLikePlaceholder('re_your_key')).toBe(true);
      expect(looksLikePlaceholder('')).toBe(true);
      expect(looksLikePlaceholder('re_FixtureKey0123456789abcdef')).toBe(false);
    });
  });
});
