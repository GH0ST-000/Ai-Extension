import type { Table } from './db';

/** `(workspaceId, email)` is unique: see prisma/schema.prisma `@@unique([workspaceId, email])`. */
export type Invite = { workspaceId: string; email: string; status: string };
export type InviteDb = { invite: Table<Invite> };

export async function inviteMember(db: InviteDb, workspaceId: string, email: string): Promise<Invite> {
  const existing = await db.invite.findFirst({ where: { workspaceId, email } });
  if (existing) {
    return existing;
  }
  return db.invite.create({ data: { workspaceId, email, status: 'pending' } });
}
