import type { PrismaService } from '../prisma/prisma.service';

/**
 * Resolve the acting workspace for legacy user-scoped call sites.
 * Prefer lastWorkspaceId; fall back to personal workspace id convention `ws_${userId}`.
 */
export async function resolveWorkspaceIdForUser(
  prisma: PrismaService,
  userId: string,
  explicitWorkspaceId?: string,
): Promise<string> {
  if (explicitWorkspaceId) {
    const membership = await prisma.workspaceMembership.findFirst({
      where: {
        workspaceId: explicitWorkspaceId,
        userId,
        status: 'active',
        workspace: { status: 'active' },
      },
      select: { workspaceId: true },
    });
    if (membership) {
      return membership.workspaceId;
    }
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { lastWorkspaceId: true },
  });
  if (user?.lastWorkspaceId) {
    const membership = await prisma.workspaceMembership.findFirst({
      where: {
        workspaceId: user.lastWorkspaceId,
        userId,
        status: 'active',
        workspace: { status: 'active' },
      },
      select: { workspaceId: true },
    });
    if (membership) {
      return membership.workspaceId;
    }
  }

  const owned = await prisma.workspaceMembership.findFirst({
    where: { userId, status: 'active', role: 'owner', workspace: { status: 'active' } },
    select: { workspaceId: true },
    orderBy: { createdAt: 'asc' },
  });
  if (owned) {
    return owned.workspaceId;
  }

  return `ws_${userId}`;
}
