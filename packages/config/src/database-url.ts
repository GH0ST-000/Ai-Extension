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

const TLS_SSLMODES = new Set(['require', 'verify-ca', 'verify-full', 'prefer']);

/** True when the URL or explicit flag enables TLS to Postgres. */
export function databaseUrlUsesTls(databaseUrl: string, databaseSslFlag: boolean): boolean {
  if (databaseSslFlag) {
    return true;
  }
  try {
    const normalized = databaseUrl
      .replace(/^postgresql:/i, 'http:')
      .replace(/^postgres:/i, 'http:');
    const params = new URL(normalized).searchParams;
    const sslmode = params.get('sslmode')?.toLowerCase();
    if (sslmode && TLS_SSLMODES.has(sslmode)) {
      return true;
    }
    if (params.get('ssl') === 'true') {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

/** Apply DATABASE_SSL=true as sslmode=require when not already present. */
export function applyDatabaseSslFlag(databaseUrl: string, databaseSslFlag: boolean): string {
  if (!databaseSslFlag) {
    return databaseUrl;
  }
  if (databaseUrlUsesTls(databaseUrl, false)) {
    return databaseUrl;
  }
  const separator = databaseUrl.includes('?') ? '&' : '?';
  return `${databaseUrl}${separator}sslmode=require`;
}
