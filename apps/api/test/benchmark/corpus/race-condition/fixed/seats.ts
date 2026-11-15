import type { Table } from './db';

export type Seat = { workspaceId: string; userId: string; role: string };
export type SeatDb = {
  membership: Table<Seat>;
  lock<R>(key: string, fn: () => Promise<R>): Promise<R>;
};

export async function addMember(
  db: SeatDb,
  workspaceId: string,
  userId: string,
  limit: number,
): Promise<void> {
  await db.lock(`seats:${workspaceId}`, async () => {
    const count = await db.membership.count({ where: { workspaceId } });
    if (count >= limit) {
      throw new Error('SEAT_LIMIT');
    }
    await db.membership.create({ data: { workspaceId, userId, role: 'member' } });
  });
}
