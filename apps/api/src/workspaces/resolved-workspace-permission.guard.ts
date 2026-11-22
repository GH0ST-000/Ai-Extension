import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { WorkspacePermission } from '@project-x/types';

import type { AuthRequestUser } from '../auth/jwt.strategy';
import { PrismaService } from '../prisma/prisma.service';
import { resolveWorkspaceIdForUser } from './resolve-workspace-id';
import { WorkspaceAuthorizationService } from './workspace-authorization.service';
import { WORKSPACE_PERMISSION_KEY, type WorkspaceRequestContext } from './workspace.decorators';
import { workspaceException } from './workspace.errors';

/**
 * M4 — RBAC at the API boundary for user-scoped routes that have no `:workspaceId` parameter
 * (e.g. /systems). The workspace is resolved exactly like the services resolve it
 * (X-Workspace-Id header, else the documented fallback — see resolveWorkspaceIdForUser), then
 * the existing WorkspaceAuthorizationService.assertAccess verifies an active membership in an
 * active workspace and the permission declared with @RequireWorkspacePermission.
 *
 * Fails closed: a route without a declared permission is refused.
 */
@Injectable()
export class ResolvedWorkspacePermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly authorization: WorkspaceAuthorizationService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context
      .switchToHttp()
      .getRequest<{ user?: AuthRequestUser; workspace?: WorkspaceRequestContext }>();
    const userId = request.user?.id;
    if (!userId) {
      throw workspaceException('WORKSPACE_ACCESS_DENIED', 'Authentication required.');
    }
    const permission = this.reflector.getAllAndOverride<WorkspacePermission | undefined>(
      WORKSPACE_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!permission) {
      throw workspaceException(
        'WORKSPACE_ACCESS_DENIED',
        'You do not have permission to perform this action.',
      );
    }
    const workspaceId = await resolveWorkspaceIdForUser(this.prisma, userId);
    request.workspace = await this.authorization.assertAccess({ userId, workspaceId, permission });
    return true;
  }
}
