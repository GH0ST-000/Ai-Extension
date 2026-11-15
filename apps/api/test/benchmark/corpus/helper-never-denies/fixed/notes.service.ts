import { assertMember } from './access';
import type { Table } from './db';

export type Note = { id: string; workspaceId: string; authorId: string; archived: boolean };
export type Membership = { workspaceId: string; userId: string; role: string; status: string };
export type NotesDb = { note: Table<Note>; membership: Table<Membership> };

export async function deleteNote(db: NotesDb, userId: string, noteId: string): Promise<void> {
  const note = await db.note.findUnique({ where: { id: noteId } });
  if (!note) {
    throw new Error('NOT_FOUND');
  }
  if (!(await assertMember(db, note.workspaceId, userId))) {
    throw new Error('FORBIDDEN');
  }
  await db.note.delete({ where: { id: noteId } });
}
