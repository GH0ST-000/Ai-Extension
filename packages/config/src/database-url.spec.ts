import { describe, expect, it } from 'vitest';

import {
  applyDatabaseSslFlag,
  databaseUrlUsesTls,
  isLocalDatabaseHost,
  postgresHostFromDatabaseUrl,
} from './database-url';

describe('database-url helpers', () => {
  it('parses postgres hostnames', () => {
    expect(
      postgresHostFromDatabaseUrl(
        'postgresql://user:pass@db.example.com:5432/projectx?schema=public',
      ),
    ).toBe('db.example.com');
  });

  it('detects TLS from sslmode or DATABASE_SSL flag', () => {
    const url = 'postgresql://user:pass@localhost:5432/projectx';
    expect(databaseUrlUsesTls(url, false)).toBe(false);
    expect(databaseUrlUsesTls(`${url}?sslmode=require`, false)).toBe(true);
    expect(databaseUrlUsesTls(url, true)).toBe(true);
  });

  it('appends sslmode=require when DATABASE_SSL is enabled', () => {
    expect(applyDatabaseSslFlag('postgresql://u:p@host/db', true)).toBe(
      'postgresql://u:p@host/db?sslmode=require',
    );
    expect(applyDatabaseSslFlag('postgresql://u:p@host/db?schema=public', true)).toContain(
      'sslmode=require',
    );
    expect(applyDatabaseSslFlag('postgresql://u:p@host/db?sslmode=verify-full', true)).toBe(
      'postgresql://u:p@host/db?sslmode=verify-full',
    );
  });

  it('classifies local database hosts', () => {
    expect(isLocalDatabaseHost('localhost')).toBe(true);
    expect(isLocalDatabaseHost('db.prod.internal')).toBe(false);
  });
});
