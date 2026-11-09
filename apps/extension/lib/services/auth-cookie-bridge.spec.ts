import { describe, expect, it } from 'vitest';

import { isTrustedApiCookie } from './auth-cookie-bridge';

describe('isTrustedApiCookie', () => {
  it('accepts the host-only cookie the API sets on its own hostname', () => {
    expect(
      isTrustedApiCookie({ domain: 'api.example.com', hostOnly: true }, 'api.example.com'),
    ).toBe(true);
  });

  it('rejects a parent-domain cookie a sibling subdomain could plant', () => {
    expect(isTrustedApiCookie({ domain: '.example.com', hostOnly: false }, 'api.example.com')).toBe(
      false,
    );
    expect(isTrustedApiCookie({ domain: 'example.com', hostOnly: true }, 'api.example.com')).toBe(
      false,
    );
  });

  it('rejects a domain cookie even on the exact API hostname', () => {
    expect(
      isTrustedApiCookie({ domain: '.api.example.com', hostOnly: false }, 'api.example.com'),
    ).toBe(false);
  });

  it('treats localhost and 127.0.0.1 as the same dev host', () => {
    expect(isTrustedApiCookie({ domain: '127.0.0.1', hostOnly: true }, 'localhost')).toBe(true);
    expect(isTrustedApiCookie({ domain: 'localhost', hostOnly: true }, '127.0.0.1')).toBe(true);
  });
});
