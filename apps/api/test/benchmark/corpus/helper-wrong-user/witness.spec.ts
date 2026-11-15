import { describe, expect, it } from 'vitest';

import { fakeTable } from '../../support/fake-db';
import { deleteNote as fixedDelete } from './fixed/delete-note';
import { deleteNote as headDelete } from './head/delete-note';

const db = () => ({
  note: fakeTable([{ id: 'n1', workspaceId: 'ws1', authorId: 'u1', archived: false }]),
  membership: fakeTable([{ workspaceId: 'ws1', userId: 'u1', role: 'owner', status: 'active' }]),
});

describe('helper-wrong-user ground truth', () => {
  it('an outsider deletes a note through the helper', async () => {
    const head = db();
    await headDelete(head, 'outsider', 'n1');
    expect(head.note.rows).toHaveLength(0);
    await expect(fixedDelete(db(), 'outsider', 'n1')).rejects.toThrow('FORBIDDEN');
  });
});
