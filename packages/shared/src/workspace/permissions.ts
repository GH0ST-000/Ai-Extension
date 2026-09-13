import type { WorkspacePermission, WorkspaceRole } from '@project-x/types';

const ALL: ReadonlyArray<WorkspacePermission> = [
  'workspace:read',
  'workspace:update',
  'workspace:delete',
  'members:read',
  'members:invite',
  'members:manage',
  'billing:read',
  'billing:manage',
  'integrations:read',
  'integrations:manage',
  'workflow:execute',
  'memory:read',
  'memory:manage',
  'systems:read',
  'systems:manage',
];

const ROLE_PERMISSIONS: Record<WorkspaceRole, ReadonlyArray<WorkspacePermission>> = {
  owner: ALL,
  admin: [
    'workspace:read',
    'workspace:update',
    'members:read',
    'members:invite',
    'members:manage',
    'billing:read',
    'integrations:read',
    'integrations:manage',
    'workflow:execute',
    'memory:read',
    'memory:manage',
    'systems:read',
    'systems:manage',
  ],
  member: [
    'workspace:read',
    'members:read',
    'billing:read',
    'integrations:read',
    'workflow:execute',
    'memory:read',
    'systems:read',
  ],
};

export function permissionsForRole(role: WorkspaceRole): WorkspacePermission[] {
  return [...ROLE_PERMISSIONS[role]];
}

export function roleHasPermission(role: WorkspaceRole, permission: WorkspacePermission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
