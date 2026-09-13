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
