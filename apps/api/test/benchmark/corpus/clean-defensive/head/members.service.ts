import type { Table } from './db';

export type Membership = { workspaceId: string; userId: string; role: string };
export type Logger = { error(message: string, error: unknown): void };

export async function removeMember(
  db: { membership: Table<Membership> },
  logger: Logger,
  actorId: string,
  workspaceId: string,
  memberId: string,
): Promise<{ removed: boolean }> {
  const actor = await db.membership.findFirst({ where: { workspaceId, userId: actorId } });
  if (!actor || actor.role !== 'owner') {
    throw new Error('FORBIDDEN');
  }
  const target = await db.membership.findFirst({ where: { workspaceId, userId: memberId } });
  if (!target) {
    return { removed: false };
  }
  try {
    await db.membership.delete({ where: { workspaceId, userId: memberId } });
  } catch (error) {
    logger.error('member removal failed', error);
    throw error;
  }
  return { removed: true };
}

export function displayName(user: { displayName?: string | null; email: string }): string {
  return user.displayName?.trim() || user.email;
}
