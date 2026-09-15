import { createHmac, timingSafeEqual } from 'node:crypto';

/** Matches @paddle/paddle-node-sdk WebhooksValidator default. */
export const PADDLE_WEBHOOK_MAX_AGE_SECONDS = 5;

export type ParsedPaddleSignatureHeader = {
  ts: number;
  h1Values: string[];
};

export function parsePaddleSignatureHeader(header: string): ParsedPaddleSignatureHeader | null {
  const trimmed = header.trim();
  if (!trimmed) return null;

  let ts: number | null = null;
  const h1Values: string[] = [];

  for (const part of trimmed.split(';')) {
    const segment = part.trim();
    if (!segment) continue;
    const eq = segment.indexOf('=');
    if (eq <= 0) continue;
    const key = segment.slice(0, eq).trim();
    const value = segment.slice(eq + 1).trim();
    if (!value) continue;
    if (key === 'ts') {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) ts = parsed;
    } else if (key === 'h1') {
      h1Values.push(value);
    }
  }

  if (ts === null || h1Values.length === 0) return null;
  return { ts, h1Values };
}

export function computePaddleWebhookHmac(
  ts: number,
  rawBody: string | Buffer,
  secret: string,
): string {
  const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  return createHmac('sha256', secret).update(`${ts}:${body}`).digest('hex');
}

function secureCompareHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

export function isPaddleWebhookTimestampValid(
  ts: number,
  options?: { maxAgeSeconds?: number; nowMs?: number },
): boolean {
  const maxAgeSeconds = options?.maxAgeSeconds ?? PADDLE_WEBHOOK_MAX_AGE_SECONDS;
  const nowMs = options?.nowMs ?? Date.now();
  const expiresAtMs = (ts + maxAgeSeconds) * 1000;
  return nowMs <= expiresAtMs;
}

/**
 * Verify Paddle Billing `Paddle-Signature` header (`ts=…;h1=…`, multiple `h1` during rotation).
 */
export function verifyPaddleWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
  options?: { maxAgeSeconds?: number; nowMs?: number },
): boolean {
  if (!signatureHeader?.trim() || !secret.trim()) return false;

  const parsed = parsePaddleSignatureHeader(signatureHeader);
  if (!parsed) return false;
  if (!isPaddleWebhookTimestampValid(parsed.ts, options)) return false;

  const expected = computePaddleWebhookHmac(parsed.ts, rawBody, secret);
  return parsed.h1Values.some((h1) => secureCompareHex(h1, expected));
}

/** Build a Paddle-compatible signature header (tests and local sandbox webhooks). */
export function buildPaddleWebhookSignatureHeader(
  rawBody: string | Buffer,
  secret: string,
  options?: { ts?: number },
): string {
  const ts = options?.ts ?? Math.floor(Date.now() / 1000);
  const h1 = computePaddleWebhookHmac(ts, rawBody, secret);
  return `ts=${ts};h1=${h1}`;
}
