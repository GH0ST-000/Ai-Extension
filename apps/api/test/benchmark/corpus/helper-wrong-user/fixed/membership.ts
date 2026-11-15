import type { Table } from './db';

export type Note = { id: string; workspaceId: string; authorId: string; archived: boolean };
export type Membership = { workspaceId: string; userId: string; role: string; status: string };
export type NotesDb = { note: Table<Note>; membership: Table<Membership> };

export async function findMembership(
  db: NotesDb,
  memberUserId: string,
  workspaceId: string,
): Promise<Membership | null> {
  return db.membership.findFirst({
    where: { workspaceId, userId: memberUserId, status: 'active' },
  });
}
