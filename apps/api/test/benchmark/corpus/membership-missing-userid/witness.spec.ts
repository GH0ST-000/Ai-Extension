import { describe, expect, it } from 'vitest';

import { fakeTable } from '../../support/fake-db';
import { assertWorkspaceMember as fixedAssert } from './fixed/workspace-access';
import { assertWorkspaceMember as headAssert } from './head/workspace-access';

const db = () => ({
  note: fakeTable([]),
  membership: fakeTable([{ workspaceId: 'ws1', userId: 'u1', role: 'owner', status: 'active' }]),
});

describe('membership-missing-userid ground truth', () => {
  it('an outsider passes the membership check', async () => {
    await expect(headAssert(db(), 'outsider', 'ws1')).resolves.toMatchObject({ userId: 'u1' });
    await expect(fixedAssert(db(), 'outsider', 'ws1')).rejects.toThrow('FORBIDDEN');
  });
});
