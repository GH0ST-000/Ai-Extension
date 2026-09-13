import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { WorkspacePermission, WorkspaceRole } from '@project-x/types';

export const WORKSPACE_PERMISSION_KEY = 'workspacePermission';

export const RequireWorkspacePermission = (
  permission: WorkspacePermission,
): ReturnType<typeof SetMetadata> => SetMetadata(WORKSPACE_PERMISSION_KEY, permission);

export type WorkspaceRequestContext = {
  workspaceId: string;
  role: WorkspaceRole;
  membershipId: string;
  permissions: WorkspacePermission[];
};

export const CurrentWorkspace = createParamDecorator(
  (_data: unknown, context: ExecutionContext): WorkspaceRequestContext => {
    const request = context.switchToHttp().getRequest<{ workspace: WorkspaceRequestContext }>();
    return request.workspace;
  },
);
