import { describe, expect, it } from 'vitest';

import {
  isDangerousUrlScheme,
  PROMPT_INJECTION_FIXTURES,
  PROMPT_INJECTION_GUARD,
  safeInternalPath,
  sanitizeExternalHttpsUrl,
} from './index';

describe('safeInternalPath', () => {
  it('allows internal relative paths', () => {
    expect(safeInternalPath('/app/billing')).toBe('/app/billing');
  });

  it('rejects open redirects', () => {
    expect(safeInternalPath('https://evil.com')).toBe('/app');
    expect(safeInternalPath('//evil.com')).toBe('/app');
    expect(safeInternalPath('/%2F%2Fevil.com')).toBe('/app');
    expect(safeInternalPath('javascript:alert(1)')).toBe('/app');
    expect(safeInternalPath('/\\evil.com')).toBe('/app');
  });
});

describe('safeInternalPath — parser-level tricks (F-32)', () => {
  it.each([
    '/\t/evil.example',
    '/\n/evil.example',
    '/\r/evil.example',
    '/\t\\evil.example',
    '/%09/evil.example',
    '/%0a/evil.example',
    '/%0d%0a/evil.example',
    '/ /evil.example',
    '/\u0000/evil.example',
    '/\u2028/evil.example',
    '\t//evil.example',
    '/%5Cevil.example',
    '/%2f/evil.example',
    '/x:y@evil.example/../..//evil.example',
  ])('rejects %j', (raw) => {
    const out = safeInternalPath(raw);
    // Whatever is returned must stay on the app's own origin when a browser resolves it.
    expect(new URL(out, 'https://app.example').origin).toBe('https://app.example');
    expect(out.startsWith('//')).toBe(false);
  });

  it.each(['/\t/evil.example', '/\n/evil.example', '/\r/evil.example', '/%09/evil.example'])(
    'falls back for %j',
    (raw) => {
      expect(safeInternalPath(raw)).toBe('/app');
    },
  );

  it.each([
    ['/app', '/app'],
    ['/app/workspace/members?tab=invites#pending', '/app/workspace/members?tab=invites#pending'],
    ['/invite/abc_DEF-123', '/invite/abc_DEF-123'],
    ['/app/systems?q=a%20b&x=1', '/app/systems?q=a%20b&x=1'],
    ['/app/../app/billing', '/app/billing'],
  ])('keeps the legitimate path %s', (raw, expected) => {
    expect(safeInternalPath(raw)).toBe(expected);
  });
});

describe('URL scheme safety', () => {
  it('flags dangerous schemes', () => {
    expect(isDangerousUrlScheme('javascript:alert(1)')).toBe(true);
    expect(isDangerousUrlScheme('data:text/html,hi')).toBe(true);
    expect(sanitizeExternalHttpsUrl('javascript:alert(1)')).toBeNull();
    expect(sanitizeExternalHttpsUrl('https://example.com/path')).toBe('https://example.com/path');
  });
});

describe('prompt injection fixtures', () => {
  it('exposes adversarial corpus and guard text', () => {
    expect(PROMPT_INJECTION_FIXTURES.length).toBeGreaterThanOrEqual(10);
    expect(PROMPT_INJECTION_GUARD).toContain('DATA');
    expect(PROMPT_INJECTION_GUARD).toContain('budget');
  });
});
