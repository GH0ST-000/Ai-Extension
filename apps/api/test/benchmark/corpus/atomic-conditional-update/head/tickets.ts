import type { Table } from './db';

export type Event = { id: string; remaining: number };
export type EventDb = { event: Table<Event> };

export async function reserveTicket(db: EventDb, eventId: string): Promise<void> {
  // One statement: the stock check and the decrement cannot interleave with another request.
  const reserved = await db.event.updateMany({
    where: { id: eventId, remaining: { gt: 0 } },
    data: { remaining: { decrement: 1 } },
  });
  if (reserved.count === 0) {
    throw new Error('SOLD_OUT');
  }
}
