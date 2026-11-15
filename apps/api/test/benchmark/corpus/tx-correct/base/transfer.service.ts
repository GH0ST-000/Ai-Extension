import type { Table } from './db';

export type Account = { id: string; credits: number };
export type WalletDb = {
  account: Table<Account>;
  /** Interactive transaction at the database default isolation (READ COMMITTED). */
  $transaction<R>(fn: (tx: { account: Table<Account> }) => Promise<R>): Promise<R>;
};

export async function transfer(db: WalletDb, fromId: string, toId: string, amount: number): Promise<void> {
  const debited = await db.account.updateMany({
    where: { id: fromId, credits: { gte: amount } },
    data: { credits: { decrement: amount } },
  });
  if (debited.count === 0) {
    throw new Error('INSUFFICIENT_FUNDS');
  }
  await db.account.update({ where: { id: toId }, data: { credits: { increment: amount } } });
}
