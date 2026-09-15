import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyGitHubWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader?.trim() || !secret.trim()) {
    return false;
  }

  const expectedPrefix = 'sha256=';
  if (!signatureHeader.startsWith(expectedPrefix)) {
    return false;
  }

  const provided = signatureHeader.slice(expectedPrefix.length).trim();
  if (!provided) {
    return false;
  }

  const digest = createHmac('sha256', secret).update(rawBody).digest('hex');
  if (digest.length !== provided.length) {
    return false;
  }

  try {
    return timingSafeEqual(Buffer.from(digest, 'utf8'), Buffer.from(provided, 'utf8'));
  } catch {
    return false;
  }
}
