/**
 * Test helper (N-1): a `workspaceMembership.findFirst` double for unit specs that models the
 * real default state — every user is the ACTIVE OWNER of their own personal workspace
 * `ws_${userId}` and a member of nothing else. Lookups for any other workspace return null, so
 * the hardened resolver still refuses foreign or unknown workspaces in these specs.
 */
export async function personalWorkspaceMembership(args?: {
  where?: { userId?: string; workspaceId?: string };
}): Promise<{ workspaceId: string; role: 'owner' } | null> {
  const userId = args?.where?.userId;
  if (!userId) return null;
  const personal = `ws_${userId}`;
  const requested = args?.where?.workspaceId ?? personal;
  return requested === personal ? { workspaceId: personal, role: 'owner' } : null;
}
