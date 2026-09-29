import type { PrismaService } from '../prisma/prisma.service';
import { peekRequestWorkspaceId } from '../observability/request-context.service';

/**
 * Resolve the acting workspace for legacy user-scoped call sites.
 * Prefer explicit / X-Workspace-Id header (ALS), then lastWorkspaceId,
 * then personal workspace id convention `ws_${userId}`.
 */
export async function resolveWorkspaceIdForUser(
  prisma: PrismaService,
  userId: string,
  explicitWorkspaceId?: string,
): Promise<string> {
  const candidate = explicitWorkspaceId ?? peekRequestWorkspaceId();
  if (candidate) {
    const membership = await prisma.workspaceMembership.findFirst({
      where: {
        workspaceId: candidate,
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
