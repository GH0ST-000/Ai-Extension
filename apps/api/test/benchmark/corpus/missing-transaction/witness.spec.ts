import { describe, expect, it } from 'vitest';

import { fakeTable } from '../../support/fake-db';
import { transferCredits as fixedTransfer } from './fixed/transfer';
import { transferCredits as headTransfer } from './head/transfer';

type Account = { id: string; credits: number };
function db() {
  const account = fakeTable<Account>(
    [
      { id: 'a', credits: 100 },
      { id: 'b', credits: 0 },
    ],
    { failWrite: (op, where) => op === 'update' && where?.id === 'b' },
  );
  return {
    account,
    async $transaction<R>(fn: (tx: { account: typeof account }) => Promise<R>): Promise<R> {
      const snapshot = account.rows.map((r) => ({ ...r }));
      try {
        return await fn({ account });
      } catch (error) {
        account.rows.splice(0, account.rows.length, ...snapshot);
        throw error;
      }
    },
  };
}

describe('missing-transaction ground truth', () => {
  it('a failed credit leaves the debit applied', async () => {
    const head = db();
    await expect(headTransfer(head, 'a', 'b', 40)).rejects.toThrow('WRITE_FAILED');
    expect(head.account.rows.find((r) => r.id === 'a')!.credits).toBe(60); // money lost
    const fixed = db();
    await expect(fixedTransfer(fixed, 'a', 'b', 40)).rejects.toThrow('WRITE_FAILED');
    expect(fixed.account.rows.find((r) => r.id === 'a')!.credits).toBe(100);
  });
});
