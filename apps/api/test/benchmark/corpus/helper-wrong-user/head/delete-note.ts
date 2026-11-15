import { findMembership } from './membership';
import type { NotesDb } from './membership';

export async function deleteNote(db: NotesDb, userId: string, noteId: string): Promise<void> {
  const note = await db.note.findUnique({ where: { id: noteId } });
  if (!note) {
    throw new Error('NOT_FOUND');
  }
  const membership = await findMembership(db, note.authorId, note.workspaceId);
  if (!membership) {
    throw new Error('FORBIDDEN');
  }
  await db.note.delete({ where: { id: noteId } });
}
