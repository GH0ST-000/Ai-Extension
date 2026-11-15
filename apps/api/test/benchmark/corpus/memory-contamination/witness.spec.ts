import { describe, expect, it } from 'vitest';

import { invoiceTotal } from './head/invoice-total';

describe('memory-contamination ground truth (no defect)', () => {
  it('the added test only exercises invoice totals; no payment handler exists in the PR', () => {
    expect(invoiceTotal([{ unitPrice: 2, quantity: 3 }])).toBe(6);
  });
});
