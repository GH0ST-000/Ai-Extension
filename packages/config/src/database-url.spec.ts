import { describe, expect, it } from 'vitest';

import {
  applyDatabaseSslFlag,
  databaseUrlUsesTls,
  databaseUrlVerifiesCertificate,
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
    // `verify-full` is a libpq value, not a Prisma one: the flag replaces it with the mode
    // Prisma enforces (certificate verification is `sslaccept=strict`).
    expect(applyDatabaseSslFlag('postgresql://u:p@host/db?sslmode=verify-full', true)).toBe(
      'postgresql://u:p@host/db?sslmode=require',
    );
    expect(applyDatabaseSslFlag('postgresql://u:p@host/db?sslmode=require', true)).toBe(
      'postgresql://u:p@host/db?sslmode=require',
    );
  });

  it('classifies local database hosts', () => {
    expect(isLocalDatabaseHost('localhost')).toBe(true);
    expect(isLocalDatabaseHost('db.prod.internal')).toBe(false);
  });
  // F-10
  it('sslmode values that permit plaintext are not TLS', () => {
    const url = 'postgresql://user:pass@db.example.com:5432/projectx';
    for (const mode of ['prefer', 'allow', 'disable', 'PREFER']) {
      expect(databaseUrlUsesTls(`${url}?sslmode=${mode}`, false)).toBe(false);
    }
    expect(databaseUrlUsesTls(`${url}?ssl=true`, false)).toBe(false);
    expect(databaseUrlUsesTls(`${url}?sslmode=require`, false)).toBe(true);
    // libpq-only values are not something the Prisma connector enforces.
    for (const mode of ['verify-ca', 'verify-full']) {
      expect(databaseUrlUsesTls(`${url}?sslmode=${mode}`, false)).toBe(false);
      expect(databaseUrlUsesTls(`${url}?sslmode=${mode}`, true)).toBe(true); // flag rewrites
    }
  });

  it('the flag replaces a weaker sslmode and keeps every other parameter', () => {
    expect(
      applyDatabaseSslFlag('postgresql://u:p@host/db?schema=public&sslmode=prefer&pool=5', true),
    ).toBe('postgresql://u:p@host/db?schema=public&pool=5&sslmode=require');
    expect(applyDatabaseSslFlag('postgresql://u:p@host/db?sslmode=disable', true)).toBe(
      'postgresql://u:p@host/db?sslmode=require',
    );
    expect(applyDatabaseSslFlag('postgresql://u:p@host/db?sslmode=disable', false)).toBe(
      'postgresql://u:p@host/db?sslmode=disable',
    );
    // With the flag, the EFFECTIVE url is what is judged.
    expect(databaseUrlUsesTls('postgresql://u:p@host/db?sslmode=disable', true)).toBe(true);
  });

  it('detects certificate verification', () => {
    const url = 'postgresql://u:p@host/db';
    expect(databaseUrlVerifiesCertificate(`${url}?sslmode=require`)).toBe(false);
    expect(databaseUrlVerifiesCertificate(`${url}?sslmode=require&sslaccept=strict`)).toBe(true);
    expect(databaseUrlVerifiesCertificate(`${url}?sslmode=verify-full`)).toBe(false);
  });

  it('repeated, upper-case and credential-embedded sslmode parameters cannot defeat the flag', () => {
    expect(
      applyDatabaseSslFlag('postgresql://u:p@host/db?sslmode=require&SSLMODE=disable&x=1', true),
    ).toBe('postgresql://u:p@host/db?x=1&sslmode=require');
    expect(
      databaseUrlUsesTls('postgresql://u:p@host/db?sslmode=require&sslmode=disable', false),
    ).toBe(false);
    // `sslmode=` inside the password is not a parameter and is left alone.
    const tricky = 'postgresql://u:p%26sslmode%3Ddisable@host/db?schema=public';
    expect(applyDatabaseSslFlag(tricky, true)).toBe(`${tricky}&sslmode=require`);
    expect(databaseUrlUsesTls(tricky, false)).toBe(false);
    expect(databaseUrlUsesTls(tricky, true)).toBe(true);
  });
});
