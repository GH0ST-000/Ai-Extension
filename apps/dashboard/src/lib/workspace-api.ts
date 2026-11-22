import type {
  AcceptWorkspaceInvitationResponse,
  BillingCheckoutResponse,
  BillingPortalResponse,
  ChangeWorkspaceMemberRoleRequest,
  CreateBillingCheckoutRequest,
  CreateWorkspaceRequest,
  InviteWorkspaceMemberRequest,
  StartGitHubAppInstallResponse,
  TransferWorkspaceOwnershipRequest,
  UpdateWorkspaceRequest,
  Workspace,
  WorkspaceBillingView,
  WorkspaceBootstrapResponse,
  WorkspaceGitHubAppStatus,
  WorkspaceInvitation,
  WorkspaceMembership,
  WorkspaceSubscription,
  WorkspaceUsageCounter,
} from '@project-x/types';

import { apiFetch } from './api';

function workspacesPath(suffix = ''): string {
  return `/workspaces${suffix}`;
}

export async function bootstrapWorkspaces(): Promise<WorkspaceBootstrapResponse> {
  return apiFetch<WorkspaceBootstrapResponse>(workspacesPath('/bootstrap'));
}

/** Decision B: the caller's free-workspace usage. */
export type FreeWorkspaceUsage = { used: number; limit: number; canCreate: boolean };

export async function getWorkspaceLimits(): Promise<FreeWorkspaceUsage> {
  return apiFetch<FreeWorkspaceUsage>(workspacesPath('/limits'));
}

export async function listWorkspaces(): Promise<Workspace[]> {
  return apiFetch<Workspace[]>(workspacesPath());
}

export async function createWorkspace(body: CreateWorkspaceRequest): Promise<Workspace> {
  return apiFetch<Workspace>(workspacesPath(), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function updateWorkspace(
  workspaceId: string,
  body: UpdateWorkspaceRequest,
): Promise<Workspace> {
  return apiFetch<Workspace>(workspacesPath(`/${encodeURIComponent(workspaceId)}`), {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function deleteWorkspace(workspaceId: string): Promise<Workspace> {
  return apiFetch<Workspace>(workspacesPath(`/${encodeURIComponent(workspaceId)}`), {
    method: 'DELETE',
  });
}

/** A workspace the caller owns that is pending deletion (N-2). */
export type PendingWorkspaceDeletion = {
  workspaceId: string;
  name: string;
  openCancellations: number;
  lastErrorCode: string | null;
  nextAttemptAt: string | null;
};

export async function listPendingDeletions(): Promise<PendingWorkspaceDeletion[]> {
  return apiFetch<PendingWorkspaceDeletion[]>(workspacesPath('/pending-deletions'));
}

export async function listMembers(workspaceId: string): Promise<WorkspaceMembership[]> {
  return apiFetch<WorkspaceMembership[]>(
    workspacesPath(`/${encodeURIComponent(workspaceId)}/members`),
  );
}

export async function inviteMember(
  workspaceId: string,
  body: InviteWorkspaceMemberRequest,
): Promise<WorkspaceInvitation> {
  return apiFetch<WorkspaceInvitation>(
    workspacesPath(`/${encodeURIComponent(workspaceId)}/invitations`),
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
  );
}

/** Pending invitations (Owners/Admins). Never includes invitation tokens. */
export async function listInvitations(workspaceId: string): Promise<WorkspaceInvitation[]> {
  return apiFetch<WorkspaceInvitation[]>(
    workspacesPath(`/${encodeURIComponent(workspaceId)}/invitations`),
  );
}

/** Revokes a pending invitation; succeeds again when it is already revoked. */
export async function revokeInvitation(workspaceId: string, invitationId: string): Promise<void> {
  await apiFetch<void>(
    workspacesPath(
      `/${encodeURIComponent(workspaceId)}/invitations/${encodeURIComponent(invitationId)}`,
    ),
    { method: 'DELETE' },
  );
}

export async function changeRole(
  workspaceId: string,
  membershipId: string,
  body: ChangeWorkspaceMemberRoleRequest,
): Promise<WorkspaceMembership> {
  return apiFetch<WorkspaceMembership>(
    workspacesPath(
      `/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(membershipId)}`,
    ),
    {
      method: 'PATCH',
      body: JSON.stringify(body),
    },
  );
}

export async function removeMember(workspaceId: string, membershipId: string): Promise<void> {
  await apiFetch<void>(
    workspacesPath(
      `/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(membershipId)}`,
    ),
    { method: 'DELETE' },
  );
}

export async function transferOwnership(
  workspaceId: string,
  body: TransferWorkspaceOwnershipRequest,
): Promise<WorkspaceMembership> {
  return apiFetch<WorkspaceMembership>(
    workspacesPath(`/${encodeURIComponent(workspaceId)}/transfer-ownership`),
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
  );
}

export async function acceptInvitation(token: string): Promise<AcceptWorkspaceInvitationResponse> {
  return apiFetch<AcceptWorkspaceInvitationResponse>(
    `/workspace-invitations/${encodeURIComponent(token)}/accept`,
    { method: 'POST' },
  );
}

export async function getBilling(workspaceId: string): Promise<WorkspaceBillingView> {
  return apiFetch<WorkspaceBillingView>(
    workspacesPath(`/${encodeURIComponent(workspaceId)}/billing`),
  );
}

export async function createCheckout(
  workspaceId: string,
  body: CreateBillingCheckoutRequest,
): Promise<BillingCheckoutResponse> {
  return apiFetch<BillingCheckoutResponse>(
    workspacesPath(`/${encodeURIComponent(workspaceId)}/billing/checkout`),
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
  );
}

export async function getPortal(workspaceId: string): Promise<BillingPortalResponse> {
  return apiFetch<BillingPortalResponse>(
    workspacesPath(`/${encodeURIComponent(workspaceId)}/billing/portal`),
    { method: 'POST' },
  );
}

export async function cancelSubscription(workspaceId: string): Promise<WorkspaceSubscription> {
  return apiFetch<WorkspaceSubscription>(
    workspacesPath(`/${encodeURIComponent(workspaceId)}/billing/cancel`),
    { method: 'POST' },
  );
}

export async function refreshBilling(workspaceId: string): Promise<WorkspaceBillingView> {
  return apiFetch<WorkspaceBillingView>(
    workspacesPath(`/${encodeURIComponent(workspaceId)}/billing/refresh`),
    { method: 'POST' },
  );
}

export async function getUsage(workspaceId: string): Promise<WorkspaceUsageCounter[]> {
  return apiFetch<WorkspaceUsageCounter[]>(
    workspacesPath(`/${encodeURIComponent(workspaceId)}/usage`),
  );
}

function githubAppPath(workspaceId: string, suffix = ''): string {
  return workspacesPath(`/${encodeURIComponent(workspaceId)}/integrations/github-app${suffix}`);
}

export async function getGithubAppStatus(workspaceId: string): Promise<WorkspaceGitHubAppStatus> {
  return apiFetch<WorkspaceGitHubAppStatus>(githubAppPath(workspaceId, '/status'));
}

export async function startGithubAppInstall(
  workspaceId: string,
): Promise<StartGitHubAppInstallResponse> {
  return apiFetch<StartGitHubAppInstallResponse>(githubAppPath(workspaceId, '/install'), {
    method: 'POST',
  });
}

/** Final step of GitHub App linking (see app/app/integrations/github-app/callback). */
export async function verifyGithubAppInstall(
  workspaceId: string,
  body: { code: string; state: string },
): Promise<WorkspaceGitHubAppStatus> {
  return apiFetch<WorkspaceGitHubAppStatus>(githubAppPath(workspaceId, '/verify'), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function disconnectGithubApp(workspaceId: string): Promise<void> {
  await apiFetch<void>(githubAppPath(workspaceId), {
    method: 'DELETE',
  });
}
