import { describe, expect, it } from 'vitest';

import { decryptSecret, encryptSecret } from './secret-box';

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
});
