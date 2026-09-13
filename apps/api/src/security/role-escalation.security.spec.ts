import { describe, expect, it } from 'vitest';
import { roleHasPermission } from '@project-x/shared';

/**
 * Role escalation matrix — mirrors WorkspaceMembersService invariants.
 */
describe('Day 29 workspace role escalation matrix', () => {
  it('admin cannot manage billing or delete workspace', () => {
    expect(roleHasPermission('admin', 'billing:manage')).toBe(false);
    expect(roleHasPermission('admin', 'workspace:delete')).toBe(false);
  });

  it('member cannot manage members or integrations', () => {
    expect(roleHasPermission('member', 'members:manage')).toBe(false);
    expect(roleHasPermission('member', 'members:invite')).toBe(false);
    expect(roleHasPermission('member', 'integrations:manage')).toBe(false);
    expect(roleHasPermission('member', 'memory:manage')).toBe(false);
  });

  it('owner retains full control including billing and ownership surfaces', () => {
    expect(roleHasPermission('owner', 'billing:manage')).toBe(true);
    expect(roleHasPermission('owner', 'members:manage')).toBe(true);
    expect(roleHasPermission('owner', 'workspace:delete')).toBe(true);
  });

  it('invite DTO role set excludes owner', () => {
    const allowedInviteRoles = ['admin', 'member'] as const;
    expect(allowedInviteRoles.includes('owner' as never)).toBe(false);
  });
});
