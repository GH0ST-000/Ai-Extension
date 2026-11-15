import type { Table } from './db';

export type Account = { id: string; credits: number };
export type WalletDb = {
  account: Table<Account>;
  /** Interactive transaction at the database default isolation (READ COMMITTED). */
  $transaction<R>(fn: (tx: { account: Table<Account> }) => Promise<R>): Promise<R>;
};

export async function withdraw(db: WalletDb, accountId: string, amount: number): Promise<void> {
  await db.$transaction(async (tx) => {
    const account = await tx.account.findUnique({ where: { id: accountId } });
    if (!account || account.credits < amount) {
      throw new Error('INSUFFICIENT_FUNDS');
    }
    await tx.account.update({ where: { id: accountId }, data: { credits: account.credits - amount } });
  });
}
