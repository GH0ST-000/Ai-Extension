import { describe, expect, it } from 'vitest';

import { decryptSecret, encryptSecret, isUnboundCiphertext } from './secret-box';

describe('secret-box', () => {
  it('round-trips plaintext', () => {
    const key = 'test-encryption-key-material';
    const cipher = encryptSecret('ghp_example_token_value', key);
    expect(cipher.startsWith('v1:')).toBe(true);
    expect(decryptSecret(cipher, key)).toBe('ghp_example_token_value');
  });

  it('fails with the wrong key', () => {
    const cipher = encryptSecret('secret', 'correct-key-material-xx');
    expect(() => decryptSecret(cipher, 'wrong-key-material-yyyy')).toThrow();
  });

  // ── F-29: contextual binding ───────────────────────────────────────────
  const KEY = 'test-encryption-key-material-0123456789';

  it('a bound ciphertext only decrypts in the context it was written for', () => {
    const forAlice = encryptSecret('ghp_alice_token', KEY, 'github_connection:alice');
    expect(forAlice.startsWith('v2:')).toBe(true);
    expect(decryptSecret(forAlice, KEY, 'github_connection:alice')).toBe('ghp_alice_token');
    // Copied into Bob's row, into another table, or read without a context: refused.
    expect(() => decryptSecret(forAlice, KEY, 'github_connection:bob')).toThrow();
    expect(() => decryptSecret(forAlice, KEY, 'jira_connection:alice')).toThrow();
    expect(() => decryptSecret(forAlice, KEY)).toThrow();
  });

  it('a bound ciphertext cannot be relabelled as the legacy unbound format', () => {
    const bound = encryptSecret('ghp_alice_token', KEY, 'github_connection:alice');
    const relabelled = `v1:${bound.slice(3)}`;
    expect(() => decryptSecret(relabelled, KEY, 'github_connection:bob')).toThrow();
    expect(() => decryptSecret(relabelled, KEY)).toThrow();
  });

  it('legacy unbound values still decrypt (existing rows survive the upgrade)', () => {
    const legacy = encryptSecret('ghp_legacy_token', KEY);
    expect(isUnboundCiphertext(legacy)).toBe(true);
    expect(decryptSecret(legacy, KEY)).toBe('ghp_legacy_token');
    expect(decryptSecret(legacy, KEY, 'github_connection:alice')).toBe('ghp_legacy_token');
    expect(isUnboundCiphertext(encryptSecret('x', KEY, 'c'))).toBe(false);
  });

  it('rejects a truncated authentication tag and a malformed IV', () => {
    const [version, iv, tag, data] = encryptSecret('secret-value', KEY, 'ctx').split(':');
    const shortTag = Buffer.from(tag!, 'base64').subarray(0, 4).toString('base64');
    expect(() => decryptSecret([version, iv, shortTag, data].join(':'), KEY, 'ctx')).toThrow(
      'Unsupported ciphertext format.',
    );
    expect(() => decryptSecret([version, 'AAAA', tag, data].join(':'), KEY, 'ctx')).toThrow(
      'Unsupported ciphertext format.',
    );
  });

  it('tampering with the ciphertext or using an unknown version fails', () => {
    const [version, iv, tag, data] = encryptSecret('secret-value', KEY, 'ctx').split(':');
    const flipped = Buffer.from(data!, 'base64');
    flipped[0] = flipped[0]! ^ 1;
    expect(() =>
      decryptSecret([version, iv, tag, flipped.toString('base64')].join(':'), KEY, 'ctx'),
    ).toThrow();
    expect(() => decryptSecret(['v3', iv, tag, data].join(':'), KEY, 'ctx')).toThrow();
  });

  it('every encryption uses a fresh IV', () => {
    const a = encryptSecret('same', KEY, 'ctx');
    const b = encryptSecret('same', KEY, 'ctx');
    expect(a).not.toBe(b);
    expect(a.split(':')[1]).not.toBe(b.split(':')[1]);
  });
});
