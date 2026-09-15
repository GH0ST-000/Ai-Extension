import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { createGitHubAppJwt } from './github-app-jwt';

describe('createGitHubAppJwt', () => {
  it('produces an RS256 JWT verifiable with the public key', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const privatePem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    const publicPem = publicKey.export({ type: 'pkcs1', format: 'pem' }).toString();

    const jwt = createGitHubAppJwt('12345', privatePem, 1_700_000_000_000);
    const parts = jwt.split('.');
    expect(parts).toHaveLength(3);

    const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];
    const signingInput = `${headerB64}.${payloadB64}`;
    const signature = Buffer.from(signatureB64, 'base64url');
    const valid = verify(
      'RSA-SHA256',
      Buffer.from(signingInput),
      createPublicKey(publicPem),
      signature,
    );
    expect(valid).toBe(true);
  });
});
