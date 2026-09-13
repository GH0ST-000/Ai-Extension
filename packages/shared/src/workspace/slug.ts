const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED = new Set([
  'api',
  'app',
  'admin',
  'billing',
  'settings',
  'workspaces',
  'www',
  'null',
  'undefined',
]);

export function normalizeWorkspaceSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export function isValidWorkspaceSlug(slug: string): boolean {
  if (!slug || slug.length < 2 || slug.length > 48) return false;
  if (RESERVED.has(slug)) return false;
  return SLUG_RE.test(slug);
}

export function personalWorkspaceName(userName: string | null | undefined, email: string): string {
  const base = userName?.trim();
  if (base && base.length > 0) {
    return `${base}'s Workspace`.slice(0, 80);
  }
  const local = email.split('@')[0]?.trim();
  if (local && local.length > 0) {
    return `${local}'s Workspace`.slice(0, 80);
  }
  return 'Personal Workspace';
}

export function personalWorkspaceSlug(userId: string): string {
  const compact = userId
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase()
    .slice(0, 16);
  return `personal-${compact || 'workspace'}`;
}
