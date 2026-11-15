import type { Table } from './db';

export type Note = { id: string; workspaceId: string; authorId: string; archived: boolean };
export type Membership = { workspaceId: string; userId: string; role: string; status: string };
export type NotesDb = { note: Table<Note>; membership: Table<Membership> };

/** Roles allowed to archive notes. Viewers and guests are read-only. */
const ARCHIVE_ROLES = ['owner', 'admin', 'editor'];

export async function archiveNote(db: NotesDb, userId: string, noteId: string): Promise<void> {
  const note = await db.note.findUnique({ where: { id: noteId } });
  if (!note) {
    throw new Error('NOT_FOUND');
  }
  const membership = await db.membership.findFirst({
    where: { workspaceId: note.workspaceId, userId, status: 'active' },
  });
  if (!membership || !ARCHIVE_ROLES.includes(membership.role)) {
    throw new Error('FORBIDDEN');
  }
  await db.note.update({ where: { id: noteId }, data: { archived: true } });
}
