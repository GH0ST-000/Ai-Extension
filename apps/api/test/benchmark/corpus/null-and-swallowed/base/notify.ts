import type { Table } from './db';

export type User = { workspaceId: string; role: string; email: string; displayName?: string | null };
export type Mailer = { send(to: string, body: string): Promise<void> };

export async function notifyOwner(
  db: { user: Table<User> },
  mailer: Mailer,
  workspaceId: string,
): Promise<{ sent: boolean }> {
  const owner = await db.user.findFirst({ where: { workspaceId, role: 'owner' } });
  if (!owner) {
    return { sent: false };
  }
  const name = owner.displayName?.trim() ?? 'there';
  await mailer.send(owner.email, `Hello ${name}`);
  return { sent: true };
}
