import { describe, expect, it } from 'vitest';
import { validateOpenApiFetchUrl } from '@project-x/shared';

/**
 * Lightweight CORS allowlist semantics used by API bootstrap.
 * Exact match only — no substring / wildcard chrome-extension://*.
 */
function isOriginAllowed(
  origin: string | undefined,
  allowlist: ReadonlySet<string>,
  nodeEnv: 'development' | 'test' | 'production',
  configuredOriginsEmpty: boolean,
): boolean {
  if (!origin) return true;
  if (origin === '*' || origin === 'null') return false;
  if (nodeEnv === 'production') {
    return allowlist.has(origin);
  }
  if (configuredOriginsEmpty) return true;
  return allowlist.has(origin);
}

describe('Day 29 CORS allowlist semantics', () => {
  const allowlist = new Set([
    'https://app.example.com',
    'chrome-extension://abcdefghijklmnopqrstuvwxyz123456',
    'https://github.com',
  ]);

  it('allows exact dashboard and extension origins in production', () => {
    expect(isOriginAllowed('https://app.example.com', allowlist, 'production', false)).toBe(true);
    expect(
      isOriginAllowed(
        'chrome-extension://abcdefghijklmnopqrstuvwxyz123456',
        allowlist,
        'production',
        false,
      ),
    ).toBe(true);
    expect(isOriginAllowed('https://github.com', allowlist, 'production', false)).toBe(true);
  });

  it('rejects evil / lookalike / wildcard origins in production', () => {
    expect(isOriginAllowed('https://evil.com', allowlist, 'production', false)).toBe(false);
    expect(
      isOriginAllowed('https://app.example.com.evil.com', allowlist, 'production', false),
    ).toBe(false);
    expect(isOriginAllowed('https://projectx.com', allowlist, 'production', false)).toBe(false);
    expect(isOriginAllowed('chrome-extension://otherid', allowlist, 'production', false)).toBe(
      false,
    );
    expect(isOriginAllowed('*', allowlist, 'production', false)).toBe(false);
    expect(isOriginAllowed('null', allowlist, 'production', false)).toBe(false);
    expect(isOriginAllowed('http://localhost:3000', allowlist, 'production', false)).toBe(false);
  });
});

describe('Day 29 SSRF metadata fixtures still blocked', () => {
  it('blocks cloud metadata URL from prompt injection fixture', () => {
    expect(validateOpenApiFetchUrl('http://169.254.169.254/latest/meta-data').ok).toBe(false);
    expect(validateOpenApiFetchUrl('https://169.254.169.254/latest/meta-data').ok).toBe(false);
  });
});
