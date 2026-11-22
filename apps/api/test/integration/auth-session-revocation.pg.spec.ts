/**
 * F-31 — refresh-token rotation racing a global session revocation (logout-all, password
 * reset), against real PostgreSQL with two real connections. Deterministic: the rotation's
 * transaction is HELD right after it inserted the new token (a latch in a Prisma proxy, no
 * sleeps); the revocation is started and observed to be blocked on a database lock; only then
 * may the rotation commit.
 *
 * Invariant: once the revocation has completed, the user has no usable refresh token.
 */
import { JwtService } from '@nestjs/jwt';
import bcrypt from 'bcrypt';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthService } from '../../src/auth/auth.service';
import { PasswordResetService, hashResetToken } from '../../src/auth/password-reset.service';

const URL_ENV = process.env.MEMORY_IT_DATABASE_URL;

describe.skipIf(!URL_ENV)('F-31: refresh rotation vs global revocation (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let observer: PrismaClient;
  const config = {
    get: (key: string) =>
      key === 'jwt.expiresIn' ? '15m' : key === 'jwt.refreshExpiresIn' ? '7d' : undefined,
  };
  const jwt = new JwtService({ secret: 'it-secret-it-secret-it-secret-0123' });
  let run = 0;

  beforeAll(async () => {
    const url = new URL(URL_ENV!);
    if (!url.pathname.endsWith('_it') || url.port === '5432') {
      throw new Error(`Refusing to run integration tests against ${url.host}${url.pathname}`);
    }
    prisma = new PrismaClient({ datasourceUrl: URL_ENV });
    observer = new PrismaClient({ datasourceUrl: URL_ENV });
    await prisma.$connect();
    await observer.$connect();
  });
  afterAll(async () => {
    await prisma?.$disconnect();
    await observer?.$disconnect();
  });

  /**
   * A Prisma client whose interactive transactions pause right after `refreshToken.create`
   * (the rotation's insert of the new token) until `release()` is called.
   */
  function gatedPrisma() {
    let inserted!: () => void;
    const tokenInserted = new Promise<void>((resolve) => (inserted = resolve));
    let release!: () => void;
    const mayCommit = new Promise<void>((resolve) => (release = resolve));
    const client = new Proxy(prisma, {
      get(target, prop, receiver) {
        if (prop !== '$transaction') return Reflect.get(target, prop, receiver);
        return (arg: unknown, ...rest: unknown[]) => {
          if (typeof arg !== 'function') {
            return (target.$transaction as (...a: unknown[]) => unknown)(arg, ...rest);
          }
          return target.$transaction(
            async (tx) => {
              const gatedTx = new Proxy(tx, {
                get(txTarget, txProp, txReceiver) {
                  if (txProp !== 'refreshToken') return Reflect.get(txTarget, txProp, txReceiver);
                  const model = txTarget.refreshToken;
                  return new Proxy(model, {
                    get(m, p, r) {
                      if (p !== 'create') return Reflect.get(m, p, r);
                      return async (args: never) => {
                        const row = await m.create(args);
                        inserted();
                        await mayCommit;
                        return row;
                      };
                    },
                  });
                },
              });
              return (arg as (t: unknown) => Promise<unknown>)(gatedTx);
            },
            { timeout: 20_000 },
          );
        };
      },
    });
    return { client, tokenInserted, release };
  }

  /** Resolves once some backend of this database is waiting on a lock. */
  async function untilBlockedOnLock(): Promise<void> {
    for (let i = 0; i < 2_000; i += 1) {
      const rows = await observer.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*) AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      if (Number(rows[0]?.n ?? 0) > 0) return;
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error('the revocation never blocked on a database lock');
  }

  async function session() {
    run += 1;
    const id = `rev_${run}_${Date.now()}`;
    await prisma.user.create({ data: { id, email: `${id}@it.test`, passwordHash: 'x' } });
    const auth = new AuthService(prisma as never, jwt, config as never);
    const issued = await (
      auth as unknown as {
        issueSession(u: unknown, c: unknown): Promise<{ refreshToken: string }>;
      }
    ).issueSession({ id, email: `${id}@it.test`, name: null, sessionVersion: 0 }, {});
    return { id, refreshToken: issued.refreshToken };
  }

  const liveTokens = (userId: string) =>
    prisma.refreshToken.count({ where: { userId, revokedAt: null } });

  async function race(revoke: (userId: string) => Promise<unknown>) {
    const { id, refreshToken } = await session();
    const gate = gatedPrisma();
    const rotating = new AuthService(gate.client as never, jwt, config as never)
      .refresh(refreshToken)
      .then(
        (result) => ({ ok: true as const, result }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    await gate.tokenInserted; // the rotation holds its transaction open, new token inserted
    const revoking = revoke(id);
    await untilBlockedOnLock(); // the revocation is waiting for the rotation
    gate.release();
    const rotation = await rotating;
    await revoking;
    return { id, rotation };
  }

  it('logout-all that overlaps a rotation leaves no usable refresh token', async () => {
    const auth = new AuthService(prisma as never, jwt, config as never);
    const { id, rotation } = await race((userId) => auth.logoutAll(userId));
    expect(await liveTokens(id)).toBe(0);
    // The rotation itself committed first (it held the lock); its token was revoked after.
    expect(rotation.ok).toBe(true);
    if (rotation.ok) {
      await expect(auth.refresh(rotation.result.refreshToken!)).rejects.toMatchObject({
        status: 401,
      });
    }
    expect(await liveTokens(id)).toBe(0);
  });

  it('a password reset that overlaps a rotation leaves no usable refresh token', async () => {
    const reset = new PasswordResetService(
      prisma as never,
      { send: async () => ({ delivered: true }) } as never,
      {
        get: () => 'https://app.example.test',
      } as never,
    );
    const token = 'R'.repeat(43);
    const auth = new AuthService(prisma as never, jwt, config as never);
    const { id, rotation } = await race(async (userId) => {
      await prisma.passwordResetToken.create({
        data: {
          userId,
          tokenHash: hashResetToken(token + userId).slice(0, 64),
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      // confirmReset looks the token up by hash: store the hash of the token we will present.
      await prisma.passwordResetToken.updateMany({
        where: { userId },
        data: { tokenHash: hashResetToken(token) },
      });
      return reset.confirmReset(token, 'a-brand-new-password-1');
    });
    expect(await liveTokens(id)).toBe(0);
    if (rotation.ok) {
      await expect(auth.refresh(rotation.result.refreshToken!)).rejects.toMatchObject({
        status: 401,
      });
    }
    await prisma.passwordResetToken.deleteMany({ where: { tokenHash: hashResetToken(token) } });
  });

  it('a revocation that commits FIRST makes the waiting rotation issue nothing', async () => {
    const { id, refreshToken } = await session();
    const auth = new AuthService(prisma as never, jwt, config as never);
    await auth.logoutAll(id);
    await expect(auth.refresh(refreshToken)).rejects.toMatchObject({ status: 401 });
    expect(await liveTokens(id)).toBe(0);
  });

  it('ordinary rotation still works and two concurrent rotations yield one descendant', async () => {
    const { id, refreshToken } = await session();
    const auth = new AuthService(prisma as never, jwt, config as never);
    const results = await Promise.allSettled([
      auth.refresh(refreshToken),
      auth.refresh(refreshToken),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await liveTokens(id)).toBe(1);
  });

  // A LOGIN whose password check overlapped a password reset must not yield a session.
  it('a login verified against the OLD password does not get a session once the reset has committed', async () => {
    run += 1;
    const id = `rev_login_${run}_${Date.now()}`;
    const email = `${id}@it.test`;
    const oldHash = await bcrypt.hash('old-password-1', 4);
    await prisma.user.create({ data: { id, email, passwordHash: oldHash } });
    const reset = new PasswordResetService(
      prisma as never,
      { send: async () => ({ delivered: true }) } as never,
      { get: () => 'https://app.example.test' } as never,
    );
    const token = 'L'.repeat(43);
    await prisma.passwordResetToken.create({
      data: {
        userId: id,
        tokenHash: hashResetToken(token),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    // The login has read the user and verified the old password; exactly before it creates
    // the session, the reset commits (new password, session version bumped, tokens revoked).
    let resetDone = false;
    const client = new Proxy(prisma, {
      get(target, prop, receiver) {
        if (prop !== '$transaction') return Reflect.get(target, prop, receiver);
        return async (arg: unknown, ...rest: unknown[]) => {
          if (!resetDone) {
            resetDone = true;
            await reset.confirmReset(token, 'a-brand-new-password-1');
          }
          return (target.$transaction as (...a: unknown[]) => unknown)(arg, ...rest);
        };
      },
    });
    const login = new AuthService(client as never, jwt, config as never).login({
      email,
      password: 'old-password-1',
    } as never);
    await expect(login).rejects.toMatchObject({ status: 401 });
    expect(resetDone).toBe(true);
    expect(await liveTokens(id)).toBe(0);

    // The new password works; the old one no longer does.
    const auth = new AuthService(prisma as never, jwt, config as never);
    await expect(auth.login({ email, password: 'old-password-1' } as never)).rejects.toMatchObject({
      status: 401,
    });
    const fresh = await auth.login({ email, password: 'a-brand-new-password-1' } as never);
    expect(fresh.refreshToken).toBeTruthy();
    await prisma.passwordResetToken.deleteMany({ where: { userId: id } });
  });

  it('a login that overlaps logout-all still works (the user just proved the current password)', async () => {
    run += 1;
    const id = `rev_login2_${run}_${Date.now()}`;
    const email = `${id}@it.test`;
    await prisma.user.create({
      data: { id, email, passwordHash: await bcrypt.hash('pw-current-1', 4) },
    });
    const auth = new AuthService(prisma as never, jwt, config as never);
    await auth.logoutAll(id);
    const session = await auth.login({ email, password: 'pw-current-1' } as never);
    // Signed with the CURRENT session version: the access token is usable.
    const claims = jwt.decode(session.accessToken!) as { sv: number };
    expect(claims.sv).toBe((await prisma.user.findUniqueOrThrow({ where: { id } })).sessionVersion);
  });
});
