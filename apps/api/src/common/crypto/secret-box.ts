import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const V1 = 'v1';
const V2 = 'v2';
const TAG_BYTES = 16;
const IV_BYTES = 12;

function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

/**
 * Encrypt a short secret (e.g. GitHub PAT) with AES-256-GCM.
 *
 * With a `context` (F-29) the ciphertext is BOUND to where it is stored: the context is the
 * GCM additional authenticated data, so the value only decrypts when presented with the same
 * context. A ciphertext copied to another user's row, another installation or another column
 * (database write access, a restored backup, an operator mistake) fails authentication instead
 * of decrypting as someone else's credential. Format: `v2:<iv>:<tag>:<ciphertext>`.
 *
 * Without a context the legacy unbound format `v1:<iv>:<tag>:<ciphertext>` is produced. New
 * code always passes a context; v1 is kept so existing rows keep working (see decryptSecret).
 *
 * A context is an identifier, not a secret (e.g. `github_connection:<userId>`).
 */
export function encryptSecret(plaintext: string, encryptionKey: string, context?: string): string {
  const key = deriveKey(encryptionKey);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  if (context !== undefined) {
    cipher.setAAD(Buffer.from(context, 'utf8'));
  }
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    context !== undefined ? V2 : V1,
    iv.toString('base64'),
    tag.toString('base64'),
    encrypted.toString('base64'),
  ].join(':');
}

/** True for a value in the legacy format that is not bound to its storage location. */
export function isUnboundCiphertext(payload: string): boolean {
  return payload.startsWith(`${V1}:`);
}

/**
 * Decrypt a value produced by encryptSecret. Throws on tamper / wrong key / wrong context.
 *
 * - `v2` values require the SAME context they were encrypted with.
 * - `v1` (legacy, unbound) values are still accepted so stored tokens survive the upgrade;
 *   callers re-encrypt them with a context when they next write (and some upgrade on read).
 *   A v2 value can never be downgraded: its tag was computed over the context.
 * - The authentication tag must be the full 16 bytes (a truncated tag supplied by someone
 *   with write access to the ciphertext would weaken forgery resistance).
 */
export function decryptSecret(payload: string, encryptionKey: string, context?: string): string {
  const parts = payload.split(':');
  if (parts.length !== 4 || (parts[0] !== V1 && parts[0] !== V2)) {
    throw new Error('Unsupported ciphertext format.');
  }

  const [version, ivB64, tagB64, dataB64] = parts;
  const key = deriveKey(encryptionKey);
  const iv = Buffer.from(ivB64!, 'base64');
  const tag = Buffer.from(tagB64!, 'base64');
  const data = Buffer.from(dataB64!, 'base64');
  if (tag.length !== TAG_BYTES || iv.length !== IV_BYTES) {
    throw new Error('Unsupported ciphertext format.');
  }
  if (version === V2 && context === undefined) {
    throw new Error('Ciphertext is bound to a context; none was provided.');
  }

  const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  if (version === V2) {
    decipher.setAAD(Buffer.from(context!, 'utf8'));
  }
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString('utf8');
}
