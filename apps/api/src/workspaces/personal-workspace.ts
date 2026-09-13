import {
  isValidWorkspaceSlug,
  normalizeWorkspaceSlug,
  personalWorkspaceName,
  personalWorkspaceSlug,
} from '@project-x/shared';
import type { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

/**
 * Creates personal workspace + OWNER membership + free subscription for a new user.
 * Call inside the same transaction that creates the user.
 */
export async function createPersonalWorkspaceForUser(
  tx: Tx,
  user: { id: string; email: string; name: string | null },
): Promise<string> {
  const slug = await allocateSlug(tx, personalWorkspaceSlug(user.id));
  const workspace = await tx.workspace.create({
    data: {
      name: personalWorkspaceName(user.name, user.email),
      slug,
      status: 'active',
      createdByUserId: user.id,
      memberships: {
        create: {
          userId: user.id,
          role: 'owner',
          status: 'active',
          joinedAt: new Date(),
        },
      },
      subscription: {
        create: {
          provider: 'paddle',
          planId: 'free',
          status: 'active',
        },
      },
    },
  });

  await tx.user.update({
    where: { id: user.id },
    data: { lastWorkspaceId: workspace.id },
  });

  return workspace.id;
}

async function allocateSlug(tx: Tx, desired: string): Promise<string> {
  let base = normalizeWorkspaceSlug(desired);
  if (!isValidWorkspaceSlug(base)) {
    base = `ws-${Math.random().toString(36).slice(2, 8)}`;
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate =
      attempt === 0 ? base : `${base.slice(0, 40)}-${Math.random().toString(36).slice(2, 8)}`;
    const existing = await tx.workspace.findUnique({
      where: { slug: candidate },
      select: { id: true },
    });
    if (!existing) {
      return candidate;
    }
  }

  return `ws-${userSafeId()}`;
}

function userSafeId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
