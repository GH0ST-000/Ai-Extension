import { describe, expect, it } from 'vitest';

import { fakeLock, fakeTable } from '../../support/fake-db';
import { addSeat } from './head/seats';

type Seat = { workspaceId: string; userId: string; role: string };

describe('race-locked ground truth (clean)', () => {
  it('concurrent adds never exceed the limit because count and insert share one lock', async () => {
    const db = { membership: fakeTable<Seat>([], { delayMs: 1 }), lock: fakeLock() };
    const results = await Promise.allSettled(
      ['a', 'b', 'c', 'd'].map((u) => addSeat(db, 'ws1', u, 2)),
    );
    expect(db.membership.rows).toHaveLength(2);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(2);
  });
});
