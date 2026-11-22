import type { NodeEnv } from '@project-x/config';

/** Dashboard origins used in local development (`next dev`). */
export const DEV_DASHBOARD_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:3001',
  'http://127.0.0.1:3001',
] as const;

function isLoopbackHttpOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      (url.hostname === 'localhost' || url.hostname === '127.0.0.1') &&
      url.origin === origin
    );
  } catch {
    return false;
  }
}

/**
 * Browser origins allowed to run cookie-setting authentication requests (login, register,
 * refresh, logout, password reset).
 *
 * - production: exact matches from AI_CORS_ORIGINS only (dashboard and extension origins).
 *   Content-script origins (e.g. https://github.com) are deliberately NOT trusted here: the
 *   extension authenticates from its own pages / service worker, never from a host page.
 * - development / test: additionally loopback dashboards and any chrome-extension:// origin
 *   (unpacked extension ids vary per machine).
 * - anything else (unknown environment): configured origins only — fail closed.
 * `null` and `*` are never trusted.
 */
export function isTrustedAuthOrigin(
  origin: string,
  input: { nodeEnv: NodeEnv | string | undefined; configuredOrigins: readonly string[] },
): boolean {
  if (origin === 'null' || origin === '*') return false;
  if (input.configuredOrigins.includes(origin)) return true;
  if (input.nodeEnv === 'development' || input.nodeEnv === 'test') {
    return isLoopbackHttpOrigin(origin) || /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
  }
  return false;
}
