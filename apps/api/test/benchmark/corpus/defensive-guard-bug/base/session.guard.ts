import type { Table } from './db';

/** `expiresAt` is epoch milliseconds. */
export type Session = { token: string; userId: string; expiresAt: number };
export type SessionDb = { session: Table<Session> };

export async function requireSession(db: SessionDb, token: string): Promise<Session> {
  const session = await db.session.findFirst({ where: { token } });
  if (!session || session.expiresAt < Date.now()) {
    throw new Error('UNAUTHORIZED');
  }
  return session;
}
