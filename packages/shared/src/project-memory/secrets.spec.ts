import { describe, expect, it } from 'vitest';

import { containsSensitiveMemoryContent, redactForMemoryLog } from './secrets';

describe('containsSensitiveMemoryContent', () => {
  it('detects ghp_ tokens', () => {
    expect(containsSensitiveMemoryContent('token ghp_abcdefghijklmnopqrstuvwxyz12')).toBe(true);
  });

  it('detects github_pat_ tokens', () => {
    expect(containsSensitiveMemoryContent('github_pat_abcdefghijklmnopqrstuvwxyzABCDEF')).toBe(
      true,
    );
  });

  it('detects Bearer tokens', () => {
    expect(containsSensitiveMemoryContent('Authorization: Bearer abcdefghijklmnop')).toBe(true);
  });

  it('detects JWT-like strings', () => {
    expect(
      containsSensitiveMemoryContent(
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc',
      ),
    ).toBe(true);
  });

  it('detects AKIA keys', () => {
    expect(containsSensitiveMemoryContent('AKIAIOSFODNN7EXAMPLE')).toBe(true);
  });

  it('detects private keys', () => {
    expect(
      containsSensitiveMemoryContent(
        '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----',
      ),
    ).toBe(true);
  });

  it('detects password=/secret=/api_key=/token= patterns', () => {
    expect(containsSensitiveMemoryContent('password=supersecret')).toBe(true);
    expect(containsSensitiveMemoryContent('secret: value123')).toBe(true);
    expect(containsSensitiveMemoryContent('api_key=abcd')).toBe(true);
    expect(containsSensitiveMemoryContent('token=xyz')).toBe(true);
  });

  it('allows ordinary project text', () => {
    expect(containsSensitiveMemoryContent('Use Vitest for unit tests.')).toBe(false);
  });
});

describe('redactForMemoryLog', () => {
  it('redacts ghp_ and Bearer without leaking secrets', () => {
    const redacted = redactForMemoryLog(
      'Authorization: Bearer abcdefghijklmnop and ghp_abcdefghijklmnopqrstuvwxyz12',
    );
    expect(redacted).toContain('[REDACTED]');
    expect(redacted).not.toContain('abcdefghijklmnop');
    expect(redacted).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz12');
  });
});
