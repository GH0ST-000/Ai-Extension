import { describe, expect, it } from 'vitest';

import {
  isPrivateOrReservedIp,
  sanitizeOpenApiDocumentUrl,
  validateOpenApiFetchUrl,
} from './safe-url';

describe('validateOpenApiFetchUrl', () => {
  it('rejects dangerous schemes', () => {
    expect(validateOpenApiFetchUrl('javascript:alert(1)').ok).toBe(false);
    expect(validateOpenApiFetchUrl('file:///etc/passwd').ok).toBe(false);
    expect(validateOpenApiFetchUrl('data:text/plain,hi').ok).toBe(false);
    expect(validateOpenApiFetchUrl('ftp://example.com/a').ok).toBe(false);
    for (const raw of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/plain,hi',
      'ftp://example.com/a',
    ]) {
      const result = validateOpenApiFetchUrl(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('scheme');
    }
  });

  it('rejects http by default (https-only)', () => {
    const result = validateOpenApiFetchUrl('http://api.example.com/openapi.json');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('scheme');
  });

  it('rejects localhost and local TLDs', () => {
    for (const raw of [
      'https://localhost/openapi.json',
      'https://api.localhost/openapi.json',
      'https://petstore.local/openapi.json',
    ]) {
      const result = validateOpenApiFetchUrl(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('blocked-host');
    }
  });

  it('rejects private and reserved IPs', () => {
    const cases = [
      'https://127.0.0.1/openapi.json',
      'https://10.0.0.5/openapi.json',
      'https://172.16.1.1/openapi.json',
      'https://172.31.255.255/openapi.json',
      'https://192.168.1.1/openapi.json',
      'https://169.254.169.254/latest/meta-data/',
      'https://[::1]/openapi.json',
      'https://[fe80::1]/openapi.json',
      'https://[fc00::1]/openapi.json',
      'https://[fd12:3456::1]/openapi.json',
    ];
    for (const raw of cases) {
      const result = validateOpenApiFetchUrl(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(['private-ip', 'blocked-host']).toContain(result.reason);
      }
    }
  });

  it('rejects metadata.google.internal', () => {
    const result = validateOpenApiFetchUrl('https://metadata.google.internal/computeMetadata/v1/');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('blocked-host');
  });

  it('rejects URLs with username/password', () => {
    const result = validateOpenApiFetchUrl('https://user:pass@api.example.com/openapi.json');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('credentials');
  });

  it('accepts a public https URL', () => {
    const result = validateOpenApiFetchUrl('https://api.example.com/v3/openapi.json');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url.hostname).toBe('api.example.com');
      expect(result.sanitizedHref).toContain('https://api.example.com');
    }
  });
});

describe('isPrivateOrReservedIp', () => {
  it('classifies private ranges', () => {
    expect(isPrivateOrReservedIp('10.1.2.3')).toBe(true);
    expect(isPrivateOrReservedIp('172.20.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('192.168.0.1')).toBe(true);
    expect(isPrivateOrReservedIp('8.8.8.8')).toBe(false);
    expect(isPrivateOrReservedIp('::1')).toBe(true);
    expect(isPrivateOrReservedIp('fe80::1')).toBe(true);
    expect(isPrivateOrReservedIp('fc00::1')).toBe(true);
    expect(isPrivateOrReservedIp('fd00::1')).toBe(true);
  });
});

describe('isIPv4 / isIPv6', () => {
  it('detects IPv4 literals', async () => {
    const { isIPv4, isIPv6 } = await import('./safe-url');
    expect(isIPv4('8.8.8.8')).toBe(true);
    expect(isIPv4('256.0.0.1')).toBe(false);
    expect(isIPv4('01.2.3.4')).toBe(false);
    expect(isIPv6('8.8.8.8')).toBe(false);
  });

  it('detects IPv6 literals including compressed and mapped forms', async () => {
    const { isIPv4, isIPv6 } = await import('./safe-url');
    expect(isIPv6('::1')).toBe(true);
    expect(isIPv6('2001:db8::1')).toBe(true);
    expect(isIPv6('[::1]')).toBe(true);
    expect(isIPv6('::ffff:127.0.0.1')).toBe(true);
    expect(isIPv6('not-an-ip')).toBe(false);
    expect(isIPv4('::1')).toBe(false);
  });
});

describe('sanitizeOpenApiDocumentUrl', () => {
  it('strips token/key/secret query params and userinfo', () => {
    expect(
      sanitizeOpenApiDocumentUrl(
        'https://user:secret@api.example.com/openapi.json?token=abc&api_key=xyz&v=1&access_token=t',
      ),
    ).toBe('https://api.example.com/openapi.json?v=1');
  });
});

describe('browser-safe module', () => {
  it('does not import Node DNS or net builtins', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('./safe-url.ts', import.meta.url), 'utf8'),
    );
    expect(source).not.toMatch(/from ['"]node:dns/);
    expect(source).not.toMatch(/from ['"]node:net/);
    expect(source).not.toMatch(/require\(['"]node:dns/);
    expect(source).not.toMatch(/require\(['"]node:net/);
  });
});
