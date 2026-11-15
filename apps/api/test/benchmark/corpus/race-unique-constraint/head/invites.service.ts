import type { Table } from './db';

/** `(workspaceId, email)` is unique: see prisma/schema.prisma `@@unique([workspaceId, email])`. */
export type Invite = { workspaceId: string; email: string; status: string };
export type InviteDb = { invite: Table<Invite> };

const UNIQUE_VIOLATION = 'P2002';

export async function inviteMember(db: InviteDb, workspaceId: string, email: string): Promise<Invite> {
  const existing = await db.invite.findFirst({ where: { workspaceId, email } });
  if (existing) {
    return existing;
  }
  try {
    return await db.invite.create({ data: { workspaceId, email, status: 'pending' } });
  } catch (error) {
    // A concurrent invite inserted the same (workspaceId, email) first: return that one.
    if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
      const winner = await db.invite.findFirst({ where: { workspaceId, email } });
      if (winner) {
        return winner;
      }
    }
    throw error;
  }
}
