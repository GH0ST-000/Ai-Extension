import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const VERSION = 'v1';

function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

/**
 * Encrypt a short secret (e.g. GitHub PAT) with AES-256-GCM.
 * Output format: v1:<iv_b64>:<tag_b64>:<ciphertext_b64>
 */
export function encryptSecret(plaintext: string, encryptionKey: string): string {
  const key = deriveKey(encryptionKey);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    VERSION,
    iv.toString('base64'),
    tag.toString('base64'),
    encrypted.toString('base64'),
  ].join(':');
}

/**
 * Decrypt a value produced by encryptSecret. Throws on tamper / wrong key.
 */
export function decryptSecret(payload: string, encryptionKey: string): string {
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Unsupported ciphertext format.');
  }

  const [, ivB64, tagB64, dataB64] = parts;
  const key = deriveKey(encryptionKey);
  const iv = Buffer.from(ivB64!, 'base64');
  const tag = Buffer.from(tagB64!, 'base64');
  const data = Buffer.from(dataB64!, 'base64');

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString('utf8');
}
