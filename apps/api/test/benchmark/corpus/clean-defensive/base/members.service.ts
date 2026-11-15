import type { Table } from './db';

export type Membership = { workspaceId: string; userId: string; role: string };
export type Logger = { error(message: string, error: unknown): void };

export async function removeMember(
  db: { membership: Table<Membership> },
  workspaceId: string,
  memberId: string,
): Promise<{ removed: boolean }> {
  await db.membership.delete({ where: { workspaceId, userId: memberId } });
  return { removed: true };
}
