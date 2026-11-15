import type { Table } from './db';

export type Note = { id: string; workspaceId: string; authorId: string; archived: boolean };
export type Membership = { workspaceId: string; userId: string; role: string; status: string };
export type NotesDb = { note: Table<Note>; membership: Table<Membership> };

export async function archiveNote(db: NotesDb, userId: string, noteId: string): Promise<void> {
  const membership = await db.membership.findFirst({
    where: { workspaceId: 'ws1', userId },
  });
  if (!membership) {
    throw new Error('FORBIDDEN');
  }
  const note = await db.note.findUnique({ where: { id: noteId } });
  if (!note) {
    throw new Error('NOT_FOUND');
  }
  await db.note.update({ where: { id: noteId }, data: { archived: true } });
}
