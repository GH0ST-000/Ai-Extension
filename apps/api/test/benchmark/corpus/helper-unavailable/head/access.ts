import type { Table } from './db';

export type Membership = { workspaceId: string; userId: string; role: string; status: string };
export type AccessDb = { membership: Table<Membership> };

/** Whether `userId` belongs to `workspaceId`. Callers decide what to do with the answer. */
export async function requireWorkspaceMember(db: AccessDb, workspaceId: string, userId: string): Promise<boolean> {
  const membership = await db.membership.findFirst({ where: { workspaceId, userId, status: 'active' } });
  return membership != null;
}
