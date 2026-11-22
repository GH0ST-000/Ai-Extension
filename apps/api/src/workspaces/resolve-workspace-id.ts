import { roleHasPermission } from '@project-x/shared';
import type { WorkspacePermission, WorkspaceRole } from '@project-x/types';

import type { PrismaService } from '../prisma/prisma.service';
import {
  peekRequestWorkspaceHeaderInvalid,
  peekRequestWorkspaceId,
} from '../observability/request-context.service';
import { workspaceException } from './workspace.errors';

/**
 * Resolve the acting workspace for legacy user-scoped call sites.
 *
 * N-1 (security): EVERY returned workspace id is one the user is an ACTIVE member of, in an
 * ACTIVE workspace (never deleted / deletion_pending), and — when `permission` is given — the
 * member's role grants it (the shared RBAC matrix). No branch returns an id on prediction alone
 * (previously the last fallback returned `ws_${userId}` unchecked, which let a removed former
 * owner of a transferred personal workspace keep using it).
 *
 * - An explicitly requested workspace (the `explicitWorkspaceId` argument, else the
 *   X-Workspace-Id header via ALS) must satisfy the above, otherwise this throws — it NEVER
 *   silently substitutes another workspace:
 *   - malformed header                         → 400 WORKSPACE_ID_INVALID
 *   - unknown / inactive / not a member / left → 403 WORKSPACE_CONTEXT_UNAVAILABLE
 *     (one response for all cases, so the error is not a workspace-existence oracle)
 *   - member without the permission            → 403 WORKSPACE_ACCESS_DENIED
 * - Only when no workspace was requested does the documented fallback apply, each candidate
 *   re-verified: lastWorkspaceId → oldest owned workspace → the personal workspace
 *   `ws_${userId}` (only while the user is still its active member). Nothing left → 403.
 */
export async function resolveWorkspaceIdForUser(
  prisma: PrismaService,
  userId: string,
  explicitWorkspaceId?: string,
  permission?: WorkspacePermission,
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
    return authorized(membership, permission);
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { lastWorkspaceId: true },
  });
  if (user?.lastWorkspaceId) {
    const membership = await findActiveMembership(prisma, userId, user.lastWorkspaceId);
    if (membership) {
      return authorized(membership, permission);
    }
  }

  const owned = await prisma.workspaceMembership.findFirst({
    where: { userId, status: 'active', role: 'owner', workspace: { status: 'active' } },
    select: { workspaceId: true, role: true },
    orderBy: { createdAt: 'asc' },
  });
  if (owned) {
    return authorized(owned, permission);
  }

  const personal = await findActiveMembership(prisma, userId, `ws_${userId}`);
  if (personal) {
    return authorized(personal, permission);
  }

  throw workspaceException(
    'WORKSPACE_CONTEXT_UNAVAILABLE',
    'No workspace is available to you. Select or create a workspace and try again.',
  );
}

function authorized(
  membership: { workspaceId: string; role: string },
  permission: WorkspacePermission | undefined,
): string {
  const known = ['owner', 'admin', 'member'].includes(membership.role);
  // Fail closed on an unknown role value.
  if (permission && !(known && roleHasPermission(membership.role as WorkspaceRole, permission))) {
    throw workspaceException(
      'WORKSPACE_ACCESS_DENIED',
      'You do not have permission to perform this action.',
      { permission, role: membership.role },
    );
  }
  return membership.workspaceId;
}

function findActiveMembership(prisma: PrismaService, userId: string, workspaceId: string) {
  return prisma.workspaceMembership.findFirst({
    where: {
      workspaceId,
      userId,
      status: 'active',
      workspace: { status: 'active' },
    },
    select: { workspaceId: true, role: true },
  });
}
