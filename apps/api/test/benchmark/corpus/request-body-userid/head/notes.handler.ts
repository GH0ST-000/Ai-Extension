import type { Table } from './db';

export type Note = { id: string; workspaceId: string; authorId: string; archived: boolean };
export type Membership = { workspaceId: string; userId: string; role: string; status: string };
export type NotesDb = { note: Table<Note>; membership: Table<Membership> };
/** `user` is set by the authentication middleware; `body` is client input. */
export type Request = { user: { id: string }; body: { userId?: string; noteId: string } };

export async function deleteNoteHandler(db: NotesDb, req: Request): Promise<void> {
  const userId = req.body.userId ?? req.user.id;
  const note = await db.note.findUnique({ where: { id: req.body.noteId } });
  if (!note) {
    throw new Error('NOT_FOUND');
  }
  const membership = await db.membership.findFirst({
    where: { workspaceId: note.workspaceId, userId },
  });
  if (!membership) {
    throw new Error('FORBIDDEN');
  }
  await db.note.delete({ where: { id: note.id } });
}
