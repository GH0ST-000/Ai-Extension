import type { Table } from './db';

export type Account = { id: string; credits: number };
export type WebhookEvent = { id: string };
export type PaymentEvent = { id: string; type: string; accountId: string; amount: number };
export type BillingDb = { account: Table<Account>; webhookEvent: Table<WebhookEvent> };

export async function handlePaymentWebhook(
  db: BillingDb,
  event: PaymentEvent,
): Promise<{ ok: boolean; duplicate?: boolean }> {
  if (event.type !== 'payment.succeeded') {
    return { ok: true };
  }
  const account = await db.account.findUnique({ where: { id: event.accountId } });
  if (!account) {
    throw new Error('UNKNOWN_ACCOUNT');
  }
  await db.account.update({ where: { id: account.id }, data: { credits: account.credits + event.amount } });
  await db.webhookEvent.create({ data: { id: event.id } });
  return { ok: true };
}
