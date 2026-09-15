import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  buildPaddleWebhookSignatureHeader,
  computePaddleWebhookHmac,
  parsePaddleSignatureHeader,
  PADDLE_WEBHOOK_MAX_AGE_SECONDS,
  verifyPaddleWebhookSignature,
} from './paddle-webhook-signature';

describe('paddle-webhook-signature', () => {
  const secret = 'pdl_ntfset_test_secret';
  const body = Buffer.from(
    JSON.stringify({ event_id: 'evt_1', event_type: 'subscription.updated' }),
  );

  it('parses ts and multiple h1 values', () => {
    expect(parsePaddleSignatureHeader('ts=1671552777;h1=abc123')).toEqual({
      ts: 1671552777,
      h1Values: ['abc123'],
    });
    expect(parsePaddleSignatureHeader('ts=1;h1=first;h1=second')).toEqual({
      ts: 1,
      h1Values: ['first', 'second'],
    });
    expect(parsePaddleSignatureHeader('sha256=deadbeef')).toBeNull();
  });

  it('computes HMAC over ts:rawBody', () => {
    const ts = 1671552777;
    const expected = createHmac('sha256', secret)
      .update(`${ts}:${body.toString('utf8')}`)
      .digest('hex');
    expect(computePaddleWebhookHmac(ts, body, secret)).toBe(expected);
  });

  it('accepts valid signatures within the replay window', () => {
    const ts = Math.floor(Date.now() / 1000);
    const header = buildPaddleWebhookSignatureHeader(body, secret, { ts });
    expect(verifyPaddleWebhookSignature(body, header, secret, { nowMs: ts * 1000 })).toBe(true);
  });

  it('rejects stale timestamps outside the replay window', () => {
    const ts = Math.floor(Date.now() / 1000) - PADDLE_WEBHOOK_MAX_AGE_SECONDS - 10;
    const header = buildPaddleWebhookSignatureHeader(body, secret, { ts });
    expect(verifyPaddleWebhookSignature(body, header, secret)).toBe(false);
  });

  it('rejects invalid h1 even when ts is fresh', () => {
    const ts = Math.floor(Date.now() / 1000);
    const header = `ts=${ts};h1=not-a-valid-signature-value-for-this-body`;
    expect(verifyPaddleWebhookSignature(body, header, secret, { nowMs: ts * 1000 })).toBe(false);
  });

  it('accepts rotation when any h1 matches', () => {
    const ts = Math.floor(Date.now() / 1000);
    const valid = computePaddleWebhookHmac(ts, body, secret);
    const header = `ts=${ts};h1=deadbeef;h1=${valid}`;
    expect(verifyPaddleWebhookSignature(body, header, secret, { nowMs: ts * 1000 })).toBe(true);
  });
});
