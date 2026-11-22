/**
 * Request URLs as written to logs. Path segments that are bearer secrets (workspace invitation
 * tokens in `/workspace-invitations/:token/accept`) are replaced, and query strings are
 * dropped (M3: an invitation token must never reach the logs).
 */
const SECRET_PATH_SEGMENTS = [/(\/workspace-invitations\/)[^/?#]+/g];

export function redactUrlForLog(url: string | undefined): string | undefined {
  if (!url) return url;
  let path = url.split('?')[0]!.split('#')[0]!;
  for (const pattern of SECRET_PATH_SEGMENTS) {
    path = path.replace(pattern, '$1[redacted]');
  }
  return path;
}

/** Secret path segments anywhere inside a string (messages, transaction names, breadcrumbs). */
export function redactSecretPathSegments(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATH_SEGMENTS) {
    out = out.replace(pattern, '$1[redacted]');
  }
  return out;
}
