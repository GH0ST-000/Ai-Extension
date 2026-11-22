/** F-13: which clients may receive the access/refresh tokens in the JSON body. */
import { describe, expect, it } from 'vitest';

import { wantsBodyTokens } from './auth.controller';

const req = (headers: Record<string, string>) => ({ headers });

describe('wantsBodyTokens (F-13)', () => {
  it('a web origin never gets body tokens, even when it claims to be the extension', () => {
    for (const origin of [
      'https://app.example.com',
      'http://localhost:3000',
      'https://evil.example',
      'null',
    ]) {
      expect(wantsBodyTokens(req({ origin, 'x-project-x-client': 'extension' }))).toBe(false);
      expect(wantsBodyTokens(req({ origin }))).toBe(false);
    }
  });

  it('a cookie-authenticated refresh never gets body tokens, whatever the headers', () => {
    const cookie = { credentialFromCookie: true };
    expect(wantsBodyTokens(req({ 'x-project-x-client': 'extension' }), cookie)).toBe(false);
    expect(wantsBodyTokens(req({}), cookie)).toBe(false);
    expect(
      wantsBodyTokens(
        req({ origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' }),
        cookie,
      ),
    ).toBe(false);
  });

  it('extension origins and origin-less clients that present their own credential do', () => {
    expect(
      wantsBodyTokens(req({ origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' })),
    ).toBe(true);
    expect(wantsBodyTokens(req({ origin: 'moz-extension://0f0e0d0c' }))).toBe(true);
    expect(wantsBodyTokens(req({ 'x-project-x-client': 'extension' }))).toBe(true);
    expect(wantsBodyTokens(req({}))).toBe(true);
  });

  it('a look-alike scheme is a web origin', () => {
    expect(wantsBodyTokens(req({ origin: 'https://chrome-extension://x' }))).toBe(false);
    expect(wantsBodyTokens(req({ origin: 'xchrome-extension://x' }))).toBe(false);
  });
});
