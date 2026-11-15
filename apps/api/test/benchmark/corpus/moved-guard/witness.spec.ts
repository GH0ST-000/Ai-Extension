import { describe, expect, it } from 'vitest';

import { fakeTable } from '../../support/fake-db';
import { archiveNote } from './head/archive';

const db = () => ({
  note: fakeTable([{ id: 'n1', workspaceId: 'ws1', authorId: 'u1', archived: false }]),
  membership: fakeTable([{ workspaceId: 'ws1', userId: 'u1', role: 'owner', status: 'active' }]),
});

describe('moved-guard ground truth (no defect)', () => {
  it('the membership guard still runs before the update', async () => {
    await expect(archiveNote(db(), 'outsider', 'n1')).rejects.toThrow('FORBIDDEN');
    const ok = db();
    await archiveNote(ok, 'u1', 'n1');
    expect(ok.note.rows[0]!.archived).toBe(true);
  });
});
