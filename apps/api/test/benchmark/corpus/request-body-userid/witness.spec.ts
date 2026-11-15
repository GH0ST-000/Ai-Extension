import { describe, expect, it } from 'vitest';

import { fakeTable } from '../../support/fake-db';
import { deleteNoteHandler as fixedDelete } from './fixed/notes.handler';
import { deleteNoteHandler as headDelete } from './head/notes.handler';

const db = () => ({
  note: fakeTable([{ id: 'n1', workspaceId: 'ws1', authorId: 'u1', archived: false }]),
  membership: fakeTable([{ workspaceId: 'ws1', userId: 'u1', role: 'owner', status: 'active' }]),
});

describe('request-body-userid ground truth', () => {
  it('an outsider deletes a note by naming a member in the body', async () => {
    const attack = { user: { id: 'outsider' }, body: { userId: 'u1', noteId: 'n1' } };
    const head = db();
    await headDelete(head, attack);
    expect(head.note.rows).toHaveLength(0);
    await expect(fixedDelete(db(), attack)).rejects.toThrow('FORBIDDEN');
  });
});
