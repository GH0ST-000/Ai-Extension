import { describe, expect, it } from 'vitest';

import { fakeTable } from '../../support/fake-db';
import { deleteNote as fixedDelete } from './fixed/notes.service';
import { deleteNote as headDelete } from './head/notes.service';

const db = () => ({
  note: fakeTable([{ id: 'n1', workspaceId: 'ws1', authorId: 'u1', archived: false }]),
  membership: fakeTable([{ workspaceId: 'ws1', userId: 'u1', role: 'owner', status: 'active' }]),
});

describe('multiline-evidence ground truth', () => {
  it('an outsider can delete a note of another workspace', async () => {
    const head = db();
    await headDelete(head, 'outsider', 'n1');
    expect(head.note.rows).toHaveLength(0);
    const fixed = db();
    await expect(fixedDelete(fixed, 'outsider', 'n1')).rejects.toThrow('FORBIDDEN');
  });
});
