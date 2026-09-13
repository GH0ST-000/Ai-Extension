import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { WorkspacePermission } from '@project-x/types';

import type { AuthRequestUser } from '../auth/jwt.strategy';
import { WorkspaceAuthorizationService } from './workspace-authorization.service';
import { WORKSPACE_PERMISSION_KEY, type WorkspaceRequestContext } from './workspace.decorators';
import { workspaceException } from './workspace.errors';

type WorkspaceAwareRequest = {
  user?: AuthRequestUser;
  headers: Record<string, string | string[] | undefined>;
  params: Record<string, string | undefined>;
  workspace?: WorkspaceRequestContext;
};

@Injectable()
export class WorkspaceGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authorization: WorkspaceAuthorizationService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<WorkspaceAwareRequest>();
    const user = request.user;
    if (!user?.id) {
      throw workspaceException('WORKSPACE_ACCESS_DENIED', 'Authentication required.');
    }

    const workspaceId = this.resolveWorkspaceId(request);
    if (!workspaceId) {
      throw workspaceException('WORKSPACE_NOT_FOUND', 'Workspace id is required.');
    }

    const permission = this.reflector.getAllAndOverride<WorkspacePermission | undefined>(
      WORKSPACE_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );

    request.workspace = await this.authorization.assertAccess({
      userId: user.id,
      workspaceId,
      permission,
    });

    return true;
  }

  private resolveWorkspaceId(request: WorkspaceAwareRequest): string | undefined {
    const fromParam = request.params.workspaceId?.trim();
    if (fromParam) {
      return fromParam;
    }

    const headerValue = request.headers['x-workspace-id'];
    if (typeof headerValue === 'string' && headerValue.trim().length > 0) {
      return headerValue.trim();
    }
    if (Array.isArray(headerValue) && headerValue[0]?.trim()) {
      return headerValue[0].trim();
    }

    return undefined;
  }
}
