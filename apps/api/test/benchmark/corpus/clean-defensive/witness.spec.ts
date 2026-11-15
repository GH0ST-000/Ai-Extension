import { describe, expect, it } from 'vitest';

import { fakeTable } from '../../support/fake-db';
import { displayName, removeMember } from './head/members.service';

type Membership = { workspaceId: string; userId: string; role: string };
const logger = { error: () => undefined };
const db = () => ({
  membership: fakeTable<Membership>([
    { workspaceId: 'ws1', userId: 'owner', role: 'owner' },
    { workspaceId: 'ws1', userId: 'ed', role: 'editor' },
    { workspaceId: 'ws1', userId: 'm1', role: 'member' },
  ]),
});

describe('clean-defensive ground truth (no defect)', () => {
  it('only owners remove members; non-members and editors are refused', async () => {
    await expect(removeMember(db(), logger, 'owner', 'ws1', 'm1')).resolves.toEqual({
      removed: true,
    });
    await expect(removeMember(db(), logger, 'ed', 'ws1', 'm1')).rejects.toThrow('FORBIDDEN');
    await expect(removeMember(db(), logger, 'outsider', 'ws1', 'm1')).rejects.toThrow('FORBIDDEN');
  });

  it('a missing target is reported, failures are logged and rethrown, display names fall back', async () => {
    await expect(removeMember(db(), logger, 'owner', 'ws1', 'ghost')).resolves.toEqual({
      removed: false,
    });
    const failing = {
      membership: fakeTable<Membership>(db().membership.rows, { failWrite: () => true }),
    };
    const errors: unknown[] = [];
    await expect(
      removeMember(failing, { error: (_m, e) => void errors.push(e) }, 'owner', 'ws1', 'm1'),
    ).rejects.toThrow('WRITE_FAILED');
    expect(errors).toHaveLength(1);
    expect(displayName({ displayName: '  ', email: 'a@x' })).toBe('a@x');
  });
});
