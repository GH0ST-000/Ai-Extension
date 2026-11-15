import { describe, expect, it } from 'vitest';

import { fakeTable } from '../../support/fake-db';
import { listNotesForUser as fixedList } from './fixed/notes.query';
import { listNotesForUser as headList } from './head/notes.query';

const db = () => ({
  note: fakeTable([
    { id: 'n1', workspaceId: 'ws1', authorId: 'u1', archived: false },
    { id: 'n2', workspaceId: 'ws2', authorId: 'u2', archived: false },
  ]),
  membership: fakeTable([{ workspaceId: 'ws1', userId: 'u1', role: 'member', status: 'active' }]),
});

describe('missing-tenant-filter ground truth', () => {
  it('a member of ws1 sees notes of ws2', async () => {
    expect((await headList(db(), 'u1', 'ws1')).map((n) => n.id)).toEqual(['n1', 'n2']);
    expect((await fixedList(db(), 'u1', 'ws1')).map((n) => n.id)).toEqual(['n1']);
  });
});
