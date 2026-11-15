import { describe, expect, it } from 'vitest';

import { invoiceTotal } from './invoice-total';

const PAYMENT_RULE = 'All payment webhook handlers must be idempotent.';

describe('invoice totals (billing)', () => {
  it('sums line items for the payments repository', () => {
    expect(PAYMENT_RULE.length).toBeGreaterThan(0);
    expect(invoiceTotal([{ unitPrice: 2, quantity: 3 }])).toBe(6);
  });
});
