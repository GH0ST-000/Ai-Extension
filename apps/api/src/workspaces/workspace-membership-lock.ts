import type { Prisma } from '@prisma/client';

/**
 * M3 — the single lock for membership, ownership and invitation changes of one workspace.
 *
 * Every operation that changes who belongs to a workspace (or with which role) — invitation
 * create / accept / revoke, role change, removal, ownership transfer — runs in a transaction
 * that FIRST takes this row lock, then re-reads and re-validates under it. They therefore
 * serialize per workspace, so "accept vs. remove", "two owner removals", "accept vs. revoke"
 * cannot interleave, and owner counts taken inside the transaction are exact.
 *
 * Workspace deletion changes `workspaces.status` with an UPDATE, which needs the same row lock:
 * an acceptance cannot slip in while deletion begins, and once committed it sees the new status.
 *
 * Lock order: the workspace row first, then membership/invitation rows. No external calls are
 * made while it is held. Released at commit/rollback.
 *
 * @returns the workspace status, or null if the workspace does not exist.
 */
export async function lockWorkspaceMembership(
  tx: Prisma.TransactionClient,
  workspaceId: string,
): Promise<string | null> {
  const rows = await tx.$queryRaw<Array<{ status: string }>>`
    SELECT status FROM workspaces WHERE id = ${workspaceId} FOR UPDATE`;
  return rows[0]?.status ?? null;
}

/**
 * F-14 — retires every pending invitation ISSUED BY `inviterUserId` in `workspaceId`. Called
 * when that person loses the right to invite (removed, or demoted below `members:invite`):
 * otherwise an admin could mint an admin invitation for a second account, be removed, and let
 * that account walk back in (and re-promote them) for as long as the link is valid.
 */
export async function revokePendingInvitationsIssuedBy(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  inviterUserId: string,
): Promise<number> {
  const result = await tx.workspaceInvitation.updateMany({
    where: { workspaceId, status: 'pending', invitedByUserId: inviterUserId },
    data: { status: 'revoked' },
  });
  return result.count;
}

/**
 * Retires every pending invitation of `email` in `workspaceId` (M3): a membership decision
 * (removal, role change, ownership transfer) must not be reversible by an invitation issued
 * before it. Invitations of other people and of other workspaces are untouched.
 */
export async function revokePendingInvitationsFor(
  tx: Prisma.TransactionClient,
  workspaceId: string,
  email: string,
): Promise<number> {
  const result = await tx.workspaceInvitation.updateMany({
    where: {
      workspaceId,
      status: 'pending',
      email: { equals: email.toLowerCase(), mode: 'insensitive' },
    },
    data: { status: 'revoked' },
  });
  return result.count;
}
