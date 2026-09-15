import type {
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

export async function acceptInvitation(token: string): Promise<WorkspaceMembership> {
  return apiFetch<WorkspaceMembership>(
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

export async function disconnectGithubApp(workspaceId: string): Promise<void> {
  await apiFetch<void>(githubAppPath(workspaceId), {
    method: 'DELETE',
  });
}
