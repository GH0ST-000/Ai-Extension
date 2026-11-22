import type { Prisma } from '@prisma/client';

import { effectivePlanId } from '../entitlements/entitlements.service';
import { workspaceException } from './workspace.errors';

/**
 * Decision B — FREE plan: at most this many free workspaces per account. Paid plans define no
 * workspace cap (none in packages/shared/src/billing/plans.ts), so paid workspaces never count
 * and paid behavior is unchanged.
 */
export const FREE_WORKSPACE_LIMIT = 2;

export type FreeWorkspaceUsage = {
  /** Free workspaces occupying a slot (see countFreeWorkspaceSlots). */
  used: number;
  limit: number;
  canCreate: boolean;
};

/** Serializes every slot-changing operation of one account (create, ownership transfer). */
export async function lockAccountWorkspaces(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('workspace-owner-limit'), hashtext(${userId}))`;
}

function startOfUsagePeriod(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Free-workspace slots an account occupies:
 * - workspaces it OWNS (active owner membership) that are active or pending deletion and whose
 *   effective plan is free (a downgraded workspace counts; nothing is ever deleted);
 * - plus free workspaces it CREATED and deleted during the current usage period: AI quota is
 *   per workspace, so a deleted workspace keeps its slot until the period ends — creating and
 *   deleting workspaces cannot mint fresh free quota (quota-cycling safeguard).
 * Memberships as Admin/Member and paid workspaces never count.
 */
export async function countFreeWorkspaceSlots(
  db: Prisma.TransactionClient,
  userId: string,
  now = new Date(),
): Promise<number> {
  const owned = await db.workspaceMembership.findMany({
    where: {
      userId,
      role: 'owner',
      status: 'active',
      workspace: { status: { in: ['active', 'deletion_pending'] } },
    },
    select: { workspace: { select: { subscription: { select: { planId: true, status: true } } } } },
  });
  const ownedFree = owned.filter(
    (m) => effectivePlanId(m.workspace.subscription ?? null) === 'free',
  ).length;
  // Decided by the plan recorded when deletion STARTED (billing rewrites the subscription row
  // afterwards; a late webhook may even write a paid plan onto it). Legacy rows (NULL) count.
  const deletedFree = await db.workspace.count({
    where: {
      createdByUserId: userId,
      status: 'deleted',
      updatedAt: { gte: startOfUsagePeriod(now) },
      // SQL NOT(col = false) would drop NULLs: legacy rows must count, so say it explicitly.
      OR: [{ deletedOnFreePlan: true }, { deletedOnFreePlan: null }],
    },
  });
  return ownedFree + deletedFree;
}

export async function freeWorkspaceUsage(
  db: Prisma.TransactionClient,
  userId: string,
): Promise<FreeWorkspaceUsage> {
  const used = await countFreeWorkspaceSlots(db, userId);
  return { used, limit: FREE_WORKSPACE_LIMIT, canCreate: used < FREE_WORKSPACE_LIMIT };
}

/** Refuses when one more free workspace would exceed the account's limit. */
export async function assertFreeWorkspaceSlot(
  db: Prisma.TransactionClient,
  userId: string,
  action: 'create' | 'receive',
): Promise<void> {
  const used = await countFreeWorkspaceSlots(db, userId);
  if (used >= FREE_WORKSPACE_LIMIT) {
    throw workspaceException(
      'WORKSPACE_LIMIT_REACHED',
      action === 'create'
        ? `Free accounts can have up to ${FREE_WORKSPACE_LIMIT} workspaces. Upgrade an existing workspace or remove one (a workspace deleted this month still counts until the month ends).`
        : `The new owner already has ${FREE_WORKSPACE_LIMIT} free workspaces. Ownership was not transferred.`,
      { used, limit: FREE_WORKSPACE_LIMIT },
    );
  }
}
