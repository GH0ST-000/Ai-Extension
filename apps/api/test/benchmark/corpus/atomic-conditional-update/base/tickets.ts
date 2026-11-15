import type { Table } from './db';

export type Event = { id: string; remaining: number };
export type EventDb = { event: Table<Event> };

export async function reserveTicket(db: EventDb, eventId: string): Promise<void> {
  const event = await db.event.findUnique({ where: { id: eventId } });
  if (!event || event.remaining <= 0) {
    throw new Error('SOLD_OUT');
  }
  await db.event.update({ where: { id: eventId }, data: { remaining: event.remaining - 1 } });
}
