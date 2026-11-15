import type { Table } from './db';

export type Account = { id: string; credits: number };
export type LedgerDb = {
  account: Table<Account>;
  $transaction<R>(fn: (tx: { account: Table<Account> }) => Promise<R>): Promise<R>;
};

export async function transferCredits(
  db: LedgerDb,
  fromId: string,
  toId: string,
  amount: number,
): Promise<void> {
  await db.$transaction(async (tx) => {
    const from = await tx.account.findUnique({ where: { id: fromId } });
    const to = await tx.account.findUnique({ where: { id: toId } });
    if (!from || !to || from.credits < amount) {
      throw new Error('INVALID_TRANSFER');
    }
    await tx.account.update({ where: { id: from.id }, data: { credits: from.credits - amount } });
    await tx.account.update({ where: { id: to.id }, data: { credits: to.credits + amount } });
  });
}
