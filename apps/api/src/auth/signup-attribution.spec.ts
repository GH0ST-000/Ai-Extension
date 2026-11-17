import { describe, expect, it } from 'vitest';

import {
  sanitizeAttributionValue,
  sanitizeReferrerHost,
  sanitizeSignupAttribution,
} from './signup-attribution';

describe('signup attribution sanitizer', () => {
  it('keeps short campaign slugs', () => {
    expect(sanitizeAttributionValue('linkedin')).toBe('linkedin');
    expect(sanitizeAttributionValue('  spring_launch-2026.v2 ')).toBe('spring_launch-2026.v2');
    expect(sanitizeAttributionValue('paid social')).toBe('paid social');
  });

  it('keeps legitimate long campaign names (regression: "internationalization")', () => {
    for (const ok of [
      'internationalization',
      'internationalization_launch_2026',
      'Spring_Launch_2026_EMEA_Partners',
      'q4-enterprise-developer-productivity-webinar-series',
      'black friday cyber monday early access',
      'ProductHunt',
      'utm.v2.2026-11',
      'a'.repeat(100),
    ]) {
      expect(sanitizeAttributionValue(ok), ok).toBe(ok);
    }
  });

  it('drops anything that could carry an email, URL, token or markup', () => {
    for (const bad of [
      'someone@example.com',
      'https://evil.example/?token=abc',
      'a=b&c=d',
      '<script>alert(1)</script>',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc', // JWT-like
      'Q3vX9kL0pZ_t7Rm2YwBn4Hc8Jd1Fs6Ge5Ka0Pq9Xz2', // reset-token-like (base64url)
      '3f786850e387550fdab836ed7e6dc881de23001b', // hex hash / commit sha
      'AKIAIOSFODNN7EXAMPLE', // AWS access key id
      'github_pat_11ABCDEFG0123456789_abcdefghijklmnop', // fine-grained PAT
      'xoxb-123456789012-abcdefghijkl', // Slack token
      '4111111111111111', // card-number-like
      '995599123456', // phone-like digit run
      'ghp_abcdefghijklmnopqrstuvwxyz0123456789', // GitHub-token-like
      'x'.repeat(101),
      '',
      '   ',
      'ünïcode',
    ]) {
      expect(sanitizeAttributionValue(bad), bad).toBeNull();
    }
    expect(sanitizeAttributionValue(42)).toBeNull();
    expect(sanitizeAttributionValue({ a: 1 })).toBeNull();
  });

  it('accepts a bare host only', () => {
    expect(sanitizeReferrerHost('News.YCombinator.com')).toBe('news.ycombinator.com');
    for (const bad of [
      'https://news.ycombinator.com/item?id=1',
      'news.ycombinator.com/path',
      'user:pass@host.com',
      'localhost',
      'host..com',
      '-bad.com',
      'a'.repeat(64) + '.com',
      'host.com:8080',
    ]) {
      expect(sanitizeReferrerHost(bad), bad).toBeNull();
    }
  });

  it('ignores unknown keys and non-object input', () => {
    expect(
      sanitizeSignupAttribution({
        utmSource: 'google',
        utmMedium: 'cpc',
        email: 'x@y.com',
        password: 'p',
        referrerHost: 'github.com',
      }),
    ).toEqual({
      utmSource: 'google',
      utmMedium: 'cpc',
      utmCampaign: null,
      utmContent: null,
      referral: null,
      referrerHost: 'github.com',
    });
    expect(sanitizeSignupAttribution('google')).toEqual({
      utmSource: null,
      utmMedium: null,
      utmCampaign: null,
      utmContent: null,
      referral: null,
      referrerHost: null,
    });
  });

  it('is linear on adversarial input', () => {
    const started = performance.now();
    sanitizeAttributionValue('a.'.repeat(200_000));
    sanitizeReferrerHost('a.'.repeat(200_000));
    expect(performance.now() - started).toBeLessThan(200);
  });
});
