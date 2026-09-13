import { describe, expect, it } from 'vitest';
import { validateOpenApiFetchUrl } from '@project-x/shared';

describe('Day 29 OpenAPI SSRF regressions', () => {
  const blocked = [
    'http://127.0.0.1/openapi.json',
    'https://localhost/openapi.json',
    'https://127.0.0.1/openapi.json',
    'https://0.0.0.0/openapi.json',
    'https://10.0.0.1/openapi.json',
    'https://172.16.5.5/openapi.json',
    'https://192.168.1.10/openapi.json',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/openapi.json',
    'https://[fc00::1]/openapi.json',
    'https://[fe80::1]/openapi.json',
    'file:///etc/passwd',
    'ftp://example.com/api.yaml',
    'https://user:pass@example.com/openapi.json',
    'https://2130706433/',
    'https://127.1/openapi.json',
  ];

  it.each(blocked)('blocks %s', (url) => {
    expect(validateOpenApiFetchUrl(url).ok).toBe(false);
  });

  it('allows public https URLs', () => {
    const result = validateOpenApiFetchUrl('https://petstore3.swagger.io/api/v3/openapi.json');
    expect(result.ok).toBe(true);
  });
});
