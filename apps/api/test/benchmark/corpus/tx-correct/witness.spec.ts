import { describe, expect, it } from 'vitest';

import { fakeTable, fakeTransaction } from '../../support/fake-db';
import { transfer } from './head/transfer.service';

type Account = { id: string; credits: number };
const bank = (failCredit = false) => {
  const account = fakeTable<Account>(
    [
      { id: 'a', credits: 100 },
      { id: 'b', credits: 0 },
    ],
    { delayMs: 1, failWrite: (op, where) => failCredit && op === 'update' && where?.id === 'b' },
  );
  return { account, $transaction: fakeTransaction({ account }) };
};

describe('tx-correct ground truth (clean)', () => {
  it('a failed credit rolls back the debit, and concurrent transfers never overdraw', async () => {
    const failing = bank(true);
    await expect(transfer(failing, 'a', 'b', 30)).rejects.toThrow('WRITE_FAILED');
    expect(failing.account.rows.map((r) => r.credits)).toEqual([100, 0]);
    const busy = bank();
    const done = await Promise.allSettled([1, 2, 3].map(() => transfer(busy, 'a', 'b', 40)));
    expect(done.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(busy.account.rows.map((r) => r.credits)).toEqual([20, 80]);
  });
});
