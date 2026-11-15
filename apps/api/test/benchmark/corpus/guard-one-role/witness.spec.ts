import { describe, expect, it } from 'vitest';

import { fakeTable } from '../../support/fake-db';
import { deleteNote as fixedDelete } from './fixed/notes.service';
import { deleteNote as headDelete } from './head/notes.service';

const db = () => ({
  note: fakeTable([{ id: 'n1', workspaceId: 'ws1', authorId: 'u1', archived: false }]),
  membership: fakeTable([{ workspaceId: 'ws1', userId: 'g1', role: 'guest', status: 'active' }]),
});

describe('guard-one-role ground truth', () => {
  it('a guest member deletes a note', async () => {
    const head = db();
    await headDelete(head, 'g1', 'n1');
    expect(head.note.rows).toHaveLength(0);
    await expect(fixedDelete(db(), 'g1', 'n1')).rejects.toThrow('FORBIDDEN');
  });
});
