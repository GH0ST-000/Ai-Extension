import type { Table } from './db';

export type Note = { id: string; workspaceId: string; authorId: string; archived: boolean };
export type Membership = { workspaceId: string; userId: string; role: string; status: string };
export type NotesDb = { note: Table<Note>; membership: Table<Membership> };

export async function listNotesForUser(
  db: NotesDb,
  userId: string,
  workspaceId: string,
): Promise<Note[]> {
  const membership = await db.membership.findFirst({ where: { workspaceId, userId } });
  if (!membership) {
    throw new Error('FORBIDDEN');
  }
  return listNotes(db, workspaceId);
}

export async function listNotes(db: NotesDb, workspaceId: string): Promise<Note[]> {
  return db.note.findMany({ where: { workspaceId, archived: false } });
}
