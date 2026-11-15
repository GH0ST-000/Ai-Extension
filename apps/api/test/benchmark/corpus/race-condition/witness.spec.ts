import { describe, expect, it } from 'vitest';

import { fakeLock, fakeTable } from '../../support/fake-db';
import { addMember as fixedAdd } from './fixed/seats';
import { addMember as headAdd } from './head/seats';

type Seat = { workspaceId: string; userId: string; role: string };
const db = () => ({ membership: fakeTable<Seat>([], { delayMs: 1 }), lock: fakeLock() });

describe('race-condition ground truth', () => {
  it('three concurrent adds exceed a limit of two', async () => {
    const head = db();
    await Promise.allSettled(['a', 'b', 'c'].map((u) => headAdd(head, 'ws1', u, 2)));
    expect(head.membership.rows).toHaveLength(3);
    const fixed = db();
    await Promise.allSettled(['a', 'b', 'c'].map((u) => fixedAdd(fixed, 'ws1', u, 2)));
    expect(fixed.membership.rows).toHaveLength(2);
  });
});
