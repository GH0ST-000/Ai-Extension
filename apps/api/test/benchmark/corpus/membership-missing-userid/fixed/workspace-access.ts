import type { Table } from './db';

export type Note = { id: string; workspaceId: string; authorId: string; archived: boolean };
export type Membership = { workspaceId: string; userId: string; role: string; status: string };
export type NotesDb = { note: Table<Note>; membership: Table<Membership> };

export async function assertWorkspaceMember(
  db: NotesDb,
  userId: string,
  workspaceId: string,
): Promise<Membership> {
  const membership = await db.membership.findFirst({
    where: { workspaceId, userId, status: 'active' },
  });
  if (!membership) {
    throw new Error('FORBIDDEN');
  }
  return membership;
}
