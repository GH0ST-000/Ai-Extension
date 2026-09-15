import { getCurrentWorkspaceId } from '../workspace/current-workspace-id';

/** Attach X-Workspace-Id when a current workspace is known. */
export async function applyWorkspaceHeader(headers: Headers): Promise<void> {
  const workspaceId = await getCurrentWorkspaceId();
  if (workspaceId && !headers.has('X-Workspace-Id')) {
    headers.set('X-Workspace-Id', workspaceId);
  }
}
