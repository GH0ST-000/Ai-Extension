import { describe, expect, it } from 'vitest';

import { fakeTable } from '../../support/fake-db';
import { reserveTicket as baseReserve } from './base/tickets';
import { reserveTicket } from './head/tickets';

type Event = { id: string; remaining: number };

describe('atomic-conditional-update ground truth (clean)', () => {
  it('concurrent reservations never oversell (the read-then-write version did)', async () => {
    const head = fakeTable<Event>([{ id: 'e1', remaining: 2 }], { delayMs: 1 });
    const results = await Promise.allSettled(
      [1, 2, 3, 4, 5].map(() => reserveTicket({ event: head }, 'e1')),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    expect(head.rows[0]!.remaining).toBe(0);
    const base = fakeTable<Event>([{ id: 'e1', remaining: 2 }], { delayMs: 1 });
    const before = await Promise.allSettled(
      [1, 2, 3, 4, 5].map(() => baseReserve({ event: base }, 'e1')),
    );
    expect(before.filter((r) => r.status === 'fulfilled').length).toBeGreaterThan(2);
  });
});
