import type { PrismaService } from '../prisma/prisma.service';
import {
  peekRequestWorkspaceHeaderInvalid,
  peekRequestWorkspaceId,
} from '../observability/request-context.service';
import { workspaceException } from './workspace.errors';

/**
 * Resolve the acting workspace for legacy user-scoped call sites.
 *
 * - An explicitly requested workspace (the `explicitWorkspaceId` argument, else the
 *   X-Workspace-Id header via ALS) must be one the user is an active member of, in an active
 *   workspace. Otherwise this throws — it NEVER silently substitutes another workspace, so a
 *   stale or spoofed selection cannot read from or write to the wrong tenant.
 *   - malformed header                         → 400 WORKSPACE_ID_INVALID
 *   - unknown / inactive / not a member / left → 403 WORKSPACE_CONTEXT_UNAVAILABLE
 *     (one response for all cases, so the error is not a workspace-existence oracle)
 * - Only when no workspace was requested at all does the documented fallback apply:
 *   lastWorkspaceId → oldest owned workspace → personal workspace id `ws_${userId}`.
 */
export async function resolveWorkspaceIdForUser(
  prisma: PrismaService,
  userId: string,
  explicitWorkspaceId?: string,
): Promise<string> {
  const explicit = explicitWorkspaceId?.trim() || undefined;
  const candidate = explicit ?? peekRequestWorkspaceId();

  if (!candidate && peekRequestWorkspaceHeaderInvalid()) {
    throw workspaceException('WORKSPACE_ID_INVALID', 'X-Workspace-Id header is malformed.');
  }

  if (candidate) {
    const membership = await findActiveMembership(prisma, userId, candidate);
    if (!membership) {
      throw workspaceException(
        'WORKSPACE_CONTEXT_UNAVAILABLE',
        'The selected workspace is not available to you. Refresh your workspace selection and try again.',
      );
    }
    return membership.workspaceId;
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { lastWorkspaceId: true },
  });
  if (user?.lastWorkspaceId) {
    const membership = await findActiveMembership(prisma, userId, user.lastWorkspaceId);
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

function findActiveMembership(prisma: PrismaService, userId: string, workspaceId: string) {
  return prisma.workspaceMembership.findFirst({
    where: {
      workspaceId,
      userId,
      status: 'active',
      workspace: { status: 'active' },
    },
    select: { workspaceId: true },
  });
}
