/**
 * Allowlisted API path prefixes for the background authenticated proxy.
 * Content scripts may only reach these surfaces — not the full API.
 */
const ALLOWED_API_PATH_PREFIXES = [
  '/auth/me',
  '/auth/logout',
  '/auth/refresh',
  '/ai/',
  '/github/',
  '/jira/',
  '/settings/',
  '/workspaces',
  '/openapi/',
  '/projects/',
  '/systems',
  '/reliability',
  '/onboarding',
  '/telemetry/',
] as const;

export function isAllowedExtensionApiPath(path: string): boolean {
  const raw = path.trim();
  if (!raw.startsWith('/')) {
    return false;
  }
  const bare = raw.split('?')[0] ?? raw;
  if (!bare.startsWith('/') || bare.includes('..') || bare.includes('//') || bare.includes('\\')) {
    return false;
  }

  return ALLOWED_API_PATH_PREFIXES.some((prefix) => {
    if (prefix.endsWith('/')) {
      return bare.startsWith(prefix) || bare === prefix.slice(0, -1);
    }
    return bare === prefix || bare.startsWith(`${prefix}/`);
  });
}
