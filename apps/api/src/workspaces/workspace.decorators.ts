import { createParamDecorator, SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { WorkspacePermission, WorkspaceRole, WorkspaceStatus } from '@project-x/types';

export const WORKSPACE_PERMISSION_KEY = 'workspacePermission';
export const WORKSPACE_ALLOWED_STATUSES_KEY = 'workspaceAllowedStatuses';

/** Accept these workspace statuses (default: active only). Deletion routes only. */
export const AllowWorkspaceStatuses = (
  ...statuses: WorkspaceStatus[]
): ReturnType<typeof SetMetadata> => SetMetadata(WORKSPACE_ALLOWED_STATUSES_KEY, statuses);

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
