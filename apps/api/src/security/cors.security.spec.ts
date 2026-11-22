import { describe, expect, it } from 'vitest';
import { validateOpenApiFetchUrl } from '@project-x/shared';

import { corsOriginAllowed } from '../common/http/configure-app';

/**
 * CORS allowlist semantics. These assertions run against `corsOriginAllowed`, the predicate
 * the real bootstrap installs (src/common/http/configure-app.ts) — not a copy of it. The HTTP
 * behaviour (preflight responses of a running app) is covered in http-boundary.http.spec.ts.
 */
const CONFIGURED = [
  'https://app.example.com',
  'chrome-extension://abcdefghijklmnopqrstuvwxyz123456',
];
const CONTENT_SCRIPTS = ['https://github.com'];
const allowed = (origin: string | undefined, nodeEnv: string, configured = CONFIGURED) =>
  corsOriginAllowed(origin, {
    nodeEnv,
    configuredOrigins: configured,
    contentScriptOrigins: CONTENT_SCRIPTS,
  });

describe('CORS allowlist semantics (real bootstrap predicate)', () => {
  it('allows exact dashboard, extension and content-script origins in production', () => {
    expect(allowed('https://app.example.com', 'production')).toBe(true);
    expect(allowed('chrome-extension://abcdefghijklmnopqrstuvwxyz123456', 'production')).toBe(true);
    expect(allowed('https://github.com', 'production')).toBe(true);
  });

  it.each([
    'https://evil.com',
    'https://app.example.com.evil.com',
    'https://evil-app.example.com',
    'https://app.example.com:8443',
    'http://app.example.com',
    'https://APP.example.com',
    'https://projectx.com',
    'chrome-extension://otherid',
    'chrome-extension://*',
    '*',
    'null',
    'http://localhost:3000',
  ])('rejects %s in production', (origin) => {
    expect(allowed(origin, 'production')).toBe(false);
  });

  it('production never reflects arbitrary origins, even with nothing configured', () => {
    expect(allowed('https://evil.com', 'production', [])).toBe(false);
    expect(allowed('http://localhost:3000', 'production', [])).toBe(false);
  });

  it('test mode uses the allowlist (plus local dashboards); only development with no configured origins is open', () => {
    expect(allowed('https://evil.com', 'test', [])).toBe(false);
    expect(allowed('http://localhost:3000', 'test', [])).toBe(true);
    expect(allowed('https://evil.com', 'development', [])).toBe(true);
    expect(allowed('https://evil.com', 'development')).toBe(false);
    expect(allowed('null', 'development', [])).toBe(false);
    expect(allowed('*', 'development', [])).toBe(false);
  });

  it('an unknown environment name is treated as production (fail closed)', () => {
    expect(allowed('http://localhost:3000', 'staging', [])).toBe(false);
    expect(allowed('https://evil.com', '', [])).toBe(false);
  });

  it('requests without an Origin are not cross-origin browser requests', () => {
    expect(allowed(undefined, 'production')).toBe(true);
  });
});

describe('Day 29 SSRF metadata fixtures still blocked', () => {
  it('blocks cloud metadata URL from prompt injection fixture', () => {
    expect(validateOpenApiFetchUrl('http://169.254.169.254/latest/meta-data').ok).toBe(false);
    expect(validateOpenApiFetchUrl('https://169.254.169.254/latest/meta-data').ok).toBe(false);
  });
});
