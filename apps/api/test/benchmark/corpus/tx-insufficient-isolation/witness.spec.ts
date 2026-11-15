import { describe, expect, it } from 'vitest';

import { fakeTable, fakeTransaction } from '../../support/fake-db';
import { withdraw as fixedWithdraw } from './fixed/wallet.service';
import { withdraw as headWithdraw } from './head/wallet.service';

type Account = { id: string; credits: number };
const wallet = () => {
  const account = fakeTable<Account>([{ id: 'a1', credits: 100 }], { delayMs: 1 });
  return { account, $transaction: fakeTransaction({ account }) };
};

describe('tx-insufficient-isolation ground truth', () => {
  it('two concurrent withdrawals overdraw the account', async () => {
    const head = wallet();
    const done = await Promise.allSettled([
      headWithdraw(head, 'a1', 60),
      headWithdraw(head, 'a1', 60),
    ]);
    // bug: both succeed (120 withdrawn from 100) and the second write overwrites the first
    expect(done.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(head.account.rows[0]!.credits).toBe(40);
    const fixed = wallet();
    const ok = await Promise.allSettled([
      fixedWithdraw(fixed, 'a1', 60),
      fixedWithdraw(fixed, 'a1', 60),
    ]);
    expect(ok.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(fixed.account.rows[0]!.credits).toBe(40);
  });
});
