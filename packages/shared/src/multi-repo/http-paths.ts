/**
 * Deterministic HTTP endpoint normalization for cross-repository matching.
 *
 * `/api/users/:id`, `/api/users/{id}`, `/api/users/${userId}` → `/api/users/{param}`.
 * Query strings, fragments, duplicate and trailing slashes are removed. Paths stay
 * case-sensitive (HTTP paths are). Nothing here performs I/O.
 */

export const HTTP_METHOD_NAMES = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
  'TRACE',
] as const;
export type HttpMethodName = (typeof HTTP_METHOD_NAMES)[number];

export const PATH_PARAM = '{param}';
const MAX_PATH_LENGTH = 512;
const MAX_SEGMENTS = 32;

export function normalizeHttpMethod(raw: string | undefined | null): HttpMethodName | undefined {
  const upper = raw?.trim().toUpperCase();
  return (HTTP_METHOD_NAMES as readonly string[]).includes(upper ?? '')
    ? (upper as HttpMethodName)
    : undefined;
}

function decodeSegment(segment: string): string {
  if (!segment.includes('%')) return segment;
  try {
    const decoded = decodeURIComponent(segment);
    // Never let decoding create new path structure.
    return decoded.includes('/') || decoded.includes('?') || decoded.includes('#')
      ? segment
      : decoded;
  } catch {
    return segment;
  }
}

function normalizeSegment(segment: string): string {
  // Express `:id` / `:id?`, OpenAPI `{id}`, template `${id}` (whole segment).
  if (/^:[A-Za-z_][\w-]*\??$/.test(segment)) return PATH_PARAM;
  if (/^\{[^{}/]+\}$/.test(segment)) return PATH_PARAM;
  if (/^\$\{[^{}]*\}$/.test(segment)) return PATH_PARAM;
  // Partially dynamic segment, e.g. `user-${id}` or `v{version}`.
  return segment
    .replace(/\$\{[^{}]*\}/g, PATH_PARAM)
    .replace(/\{[^{}/]+\}/g, (m) => (m === PATH_PARAM ? m : PATH_PARAM));
}

/**
 * Normalize a path or URL to a comparable route pattern. Absolute URLs keep only their path.
 * Returns null for anything that is not an absolute path (e.g. `users`, `mailto:`).
 */
export function normalizeHttpPath(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string') return null;
  let value = raw.trim();
  if (!value || value.length > MAX_PATH_LENGTH * 4) return null;
  const absolute = value.match(/^https?:\/\/[^/?#]*(.*)$/i);
  if (absolute) value = absolute[1] || '/';
  if (!value.startsWith('/')) return null;
  value = value.split(/[?#]/)[0]!;
  const segments = value
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => normalizeSegment(decodeSegment(s)));
  if (segments.length > MAX_SEGMENTS) return null;
  const path = `/${segments.join('/')}`;
  return path.length > MAX_PATH_LENGTH ? null : path;
}

/** Join route prefixes (`/api` + `users/:id`) and normalize. */
export function joinHttpPath(...parts: Array<string | undefined | null>): string | null {
  const joined = parts
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
  return normalizeHttpPath(`/${joined}`);
}

/**
 * Does a consumer call match a provider route? Same number of segments; each segment equal,
 * or the provider declares a parameter there. A consumer `{param}` only matches a provider
 * `{param}` (a dynamic call is never assumed to hit a literal route such as `/users/me`).
 */
export function httpPathsMatch(consumer: string, provider: string): boolean {
  if (consumer === provider) return true;
  const c = consumer.split('/');
  const p = provider.split('/');
  if (c.length !== p.length) return false;
  for (let i = 0; i < c.length; i += 1) {
    const cs = c[i]!;
    const ps = p[i]!;
    if (cs === ps) continue;
    if (ps === PATH_PARAM && cs !== '' && cs !== PATH_PARAM) continue;
    return false;
  }
  return true;
}

/** Methods are compatible when equal, or when either side could not be determined. */
export function httpMethodsMatch(a: string | undefined, b: string | undefined): boolean {
  return !a || !b || a === b;
}

/**
 * Endpoints every service tends to expose. A match on these alone never proves that one
 * repository depends on another.
 */
const GENERIC_PATHS = new Set([
  '/',
  '/health',
  '/healthz',
  '/health/live',
  '/health/ready',
  '/livez',
  '/readyz',
  '/ready',
  '/readiness',
  '/live',
  '/liveness',
  '/ping',
  '/status',
  '/metrics',
  '/version',
  '/info',
  '/favicon.ico',
  '/robots.txt',
]);

export function isGenericHttpPath(path: string): boolean {
  const lower = path.toLowerCase();
  return GENERIC_PATHS.has(lower) || /^\/(api\/)?(v\d+\/)?(health|status|ping)$/.test(lower);
}

/** Parse "GET /api/users/{id}" (method optional). */
export function parseEndpointSpec(raw: unknown): { method?: HttpMethodName; path: string } | null {
  if (typeof raw !== 'string' || raw.length > 600) return null;
  const match = raw.trim().match(/^(?:([A-Za-z]+)\s+)?(\S+)$/);
  if (!match) return null;
  const method = match[1] ? normalizeHttpMethod(match[1]) : undefined;
  if (match[1] && !method) return null;
  const path = normalizeHttpPath(match[2]);
  return path ? { ...(method ? { method } : {}), path } : null;
}
