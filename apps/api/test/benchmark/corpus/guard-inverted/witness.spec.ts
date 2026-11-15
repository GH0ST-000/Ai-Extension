import { describe, expect, it } from 'vitest';

import { fakeTable } from '../../support/fake-db';
import { deleteNote as fixedDelete } from './fixed/notes.service';
import { deleteNote as headDelete } from './head/notes.service';

const db = () => ({
  note: fakeTable([{ id: 'n1', workspaceId: 'ws1', authorId: 'u1', archived: false }]),
  membership: fakeTable([{ workspaceId: 'ws1', userId: 'u1', role: 'owner', status: 'active' }]),
});

describe('guard-inverted ground truth', () => {
  it('an outsider deletes and a member is refused', async () => {
    const head = db();
    await headDelete(head, 'outsider', 'n1');
    expect(head.note.rows).toHaveLength(0);
    await expect(headDelete(db(), 'u1', 'n1')).rejects.toThrow('FORBIDDEN');
    await expect(fixedDelete(db(), 'outsider', 'n1')).rejects.toThrow('FORBIDDEN');
  });
});
