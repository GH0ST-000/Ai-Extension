import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { verifyGitHubWebhookSignature } from './github-app-webhook-signature';

describe('verifyGitHubWebhookSignature', () => {
  it('accepts valid sha256 signatures', () => {
    const secret = 'webhook-secret';
    const body = Buffer.from('{"action":"created"}');
    const digest = createHmac('sha256', secret).update(body).digest('hex');

    expect(verifyGitHubWebhookSignature(body, `sha256=${digest}`, secret)).toBe(true);
  });

  it('rejects tampered payloads', () => {
    const secret = 'webhook-secret';
    const body = Buffer.from('{"action":"created"}');
    const digest = createHmac('sha256', secret).update(body).digest('hex');

    expect(verifyGitHubWebhookSignature(Buffer.from('{}'), `sha256=${digest}`, secret)).toBe(false);
  });
});
