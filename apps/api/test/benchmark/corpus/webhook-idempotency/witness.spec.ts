import { describe, expect, it } from 'vitest';

import { fakeTable } from '../../support/fake-db';
import { handlePaymentWebhook as fixedHandle } from './fixed/payment-webhook';
import { handlePaymentWebhook as headHandle } from './head/payment-webhook';

const event = { id: 'evt_1', type: 'payment.succeeded', accountId: 'a1', amount: 100 };
const db = () => ({
  account: fakeTable([{ id: 'a1', credits: 0 }]),
  webhookEvent: fakeTable<{ id: string }>([]),
});

describe('webhook-idempotency ground truth', () => {
  it('a redelivered event credits twice', async () => {
    const head = db();
    await headHandle(head, event);
    await headHandle(head, event);
    expect(head.account.rows[0]!.credits).toBe(200);
    const fixed = db();
    await fixedHandle(fixed, event);
    await expect(fixedHandle(fixed, event)).resolves.toMatchObject({ duplicate: true });
    expect(fixed.account.rows[0]!.credits).toBe(100);
  });
});
