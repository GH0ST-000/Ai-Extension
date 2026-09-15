import { createSign } from 'node:crypto';

function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64url');
}

/**
 * GitHub App authentication JWT (RS256), valid up to 10 minutes.
 * @see https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app
 */
export function createGitHubAppJwt(
  appId: string,
  privateKeyPem: string,
  nowMs = Date.now(),
): string {
  const now = Math.floor(nowMs / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iat: now - 60,
    exp: now + 600,
    iss: appId,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signature = createSign('RSA-SHA256').update(signingInput).sign(privateKeyPem);
  return `${signingInput}.${base64UrlEncode(signature)}`;
}
