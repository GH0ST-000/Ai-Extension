const LOCAL_DB_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/** Parse hostname from a PostgreSQL connection URL (Prisma-style). */
export function postgresHostFromDatabaseUrl(databaseUrl: string): string | null {
  try {
    const normalized = databaseUrl
      .replace(/^postgresql:/i, 'http:')
      .replace(/^postgres:/i, 'http:');
    return new URL(normalized).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function isLocalDatabaseHost(host: string | null): boolean {
  if (!host) return true;
  return LOCAL_DB_HOSTS.has(host);
}

export function isLocalRedisHost(host: string): boolean {
  return LOCAL_DB_HOSTS.has(host.toLowerCase());
}

/**
 * The only `sslmode` under which the Prisma PostgreSQL connector REQUIRES an encrypted
 * connection. Its documented values are `disable`, `prefer` (the default) and `require`:
 * `prefer` / `allow` fall back to plaintext when the server (or anyone on the path) refuses
 * TLS — the downgrade the production check exists to prevent (F-10) — and libpq's
 * `verify-ca` / `verify-full` are not Prisma values, so they must not be taken as a guarantee
 * either. Certificate verification is a separate Prisma parameter: `sslaccept=strict`.
 */
const REQUIRED_SSLMODE = 'require';

/** The query string of a connection URL (after the first `?` that follows the authority). */
function splitQuery(databaseUrl: string): { base: string; params: string[] } {
  const at = databaseUrl.lastIndexOf('@');
  const mark = databaseUrl.indexOf('?', at < 0 ? 0 : at);
  if (mark < 0) return { base: databaseUrl, params: [] };
  return {
    base: databaseUrl.slice(0, mark),
    params: databaseUrl
      .slice(mark + 1)
      .split('&')
      .filter((p) => p.length > 0),
  };
}

function paramValues(databaseUrl: string, name: string): string[] {
  return splitQuery(databaseUrl)
    .params.filter((p) => p.split('=')[0]!.toLowerCase() === name)
    .map((p) => decodeURIComponent(p.slice(p.indexOf('=') + 1)).toLowerCase());
}

/**
 * True when the EFFECTIVE connection (the URL Prisma is given: `applyDatabaseSslFlag`) must
 * use TLS: every `sslmode` parameter present is `require` (a repeated parameter with a weaker
 * value does not pass). `ssl=true` is not accepted — it is not a Prisma connection parameter.
 */
export function databaseUrlUsesTls(databaseUrl: string, databaseSslFlag: boolean): boolean {
  const effective = databaseSslFlag ? applyDatabaseSslFlag(databaseUrl, true) : databaseUrl;
  const modes = paramValues(effective, 'sslmode');
  return modes.length > 0 && modes.every((mode) => mode === REQUIRED_SSLMODE);
}

/** True when the server certificate is also verified (Prisma: `sslaccept=strict`). */
export function databaseUrlVerifiesCertificate(databaseUrl: string): boolean {
  const accept = paramValues(databaseUrl, 'sslaccept');
  return accept.length > 0 && accept.every((value) => value === 'strict');
}

/**
 * DATABASE_SSL=true: the connection URL is made to require TLS. Every existing `sslmode`
 * parameter (any case, any value, however often repeated) is removed from the QUERY part and
 * a single `sslmode=require` is appended — the flag is never a no-op, and nothing outside the
 * query (credentials, host, path) is touched.
 */
export function applyDatabaseSslFlag(databaseUrl: string, databaseSslFlag: boolean): string {
  if (!databaseSslFlag) {
    return databaseUrl;
  }
  const { base, params } = splitQuery(databaseUrl);
  const kept = params.filter((p) => p.split('=')[0]!.toLowerCase() !== 'sslmode');
  const modes = paramValues(databaseUrl, 'sslmode');
  if (modes.length === 1 && modes[0] === REQUIRED_SSLMODE) {
    return databaseUrl;
  }
  return `${base}?${[...kept, `sslmode=${REQUIRED_SSLMODE}`].join('&')}`;
}
