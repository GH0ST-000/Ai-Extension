import { describe, expect, it } from 'vitest';

import { fakeTable } from '../../support/fake-db';
import { archiveNote } from './head/notes.service';

const db = () => ({
  note: fakeTable([{ id: 'n1', workspaceId: 'ws1', authorId: 'u1', archived: false }]),
  membership: fakeTable([
    { workspaceId: 'ws1', userId: 'editor', role: 'editor', status: 'active' },
    { workspaceId: 'ws1', userId: 'viewer', role: 'viewer', status: 'active' },
    { workspaceId: 'ws1', userId: 'guest', role: 'guest', status: 'active' },
    { workspaceId: 'ws1', userId: 'gone', role: 'admin', status: 'removed' },
  ]),
});

describe('role-check-correct ground truth (clean)', () => {
  it('only active owners, admins and editors can archive; viewers, guests and outsiders cannot', async () => {
    for (const user of ['viewer', 'guest', 'gone', 'outsider']) {
      const d = db();
      await expect(archiveNote(d, user, 'n1')).rejects.toThrow('FORBIDDEN');
      expect(d.note.rows[0]!.archived).toBe(false);
    }
    const d = db();
    await archiveNote(d, 'editor', 'n1');
    expect(d.note.rows[0]!.archived).toBe(true);
  });
});
