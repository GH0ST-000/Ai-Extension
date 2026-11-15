import { describe, expect, it } from 'vitest';

import { invoiceTotal as baseTotal } from './base/invoice-total';
import { invoiceTotal as headTotal } from './head/invoice-total';

describe('clean-refactor ground truth (no behavior change)', () => {
  it('produces the same totals as before for representative invoices', () => {
    const invoices = [
      [],
      [{ unitPrice: 0.1, quantity: 3 }],
      [
        { unitPrice: 19.99, quantity: 3 },
        { unitPrice: 0.333, quantity: 7 },
      ],
      [{ unitPrice: 1e6, quantity: 1.5 }],
    ];
    for (const items of invoices) expect(headTotal(items)).toBe(baseTotal(items));
  });
});
