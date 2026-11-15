import { describe, expect, it } from 'vitest';

import { fakeTable } from '../../support/fake-db';
import { deleteNoteHandler } from './head/notes.handler';

const db = () => ({
  note: fakeTable([{ id: 'n1', workspaceId: 'ws1', authorId: 'u1', archived: false }]),
  membership: fakeTable([{ workspaceId: 'ws1', userId: 'u1', role: 'owner', status: 'active' }]),
});

describe('request-principal-userid ground truth (no defect)', () => {
  it('a body userId cannot impersonate a member; the authenticated member can delete', async () => {
    await expect(
      deleteNoteHandler(db(), { user: { id: 'outsider' }, body: { userId: 'u1', noteId: 'n1' } }),
    ).rejects.toThrow('FORBIDDEN');
    const ok = db();
    await deleteNoteHandler(ok, { user: { id: 'u1' }, body: { noteId: 'n1' } });
    expect(ok.note.rows).toHaveLength(0);
  });
});
