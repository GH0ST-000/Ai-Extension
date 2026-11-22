import {
  ConflictException,
  Injectable,
  Logger,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { personalWorkspaceName, personalWorkspaceSlug } from '@project-x/shared';

import type { AuthTokenResponse } from '@project-x/types';
import { MARKETING_CONSENT_VERSION } from '@project-x/types';

import type { ApiConfig } from '../config/configuration';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { durationToSeconds } from './auth-cookies';
import { sanitizeSignupAttribution } from './signup-attribution';
import type { LoginDto, RegisterDto } from './dto/auth.dto';
import { SecurityAuditService } from '../observability/security-audit.service';

/**
 * The dashboard (cookie) and the extension (body) share one refresh family, so two
 * clients can legitimately present the same token a moment apart. Within this window
 * the loser gets a plain 401 (and adopts the winner's session) instead of tripping
 * reuse detection and revoking the family.
 */
const REFRESH_ROTATION_GRACE_MS = 30_000;

/** Refresh lost a race with a concurrent rotation; the session itself is still valid. */
/** Serializes rotation and family revocation of one refresh-token family (released at commit). */
async function lockRefreshFamily(tx: Prisma.TransactionClient, familyId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('refresh-family'), hashtext(${familyId}))`;
}

const REGISTRATION_SLUG_ATTEMPTS = 3;

/** The unique-constraint target of a Prisma P2002 error (lower-cased), or null. */
function uniqueViolationTarget(error: unknown): string | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return null;
  }
  const target = (error.meta as { target?: unknown } | undefined)?.target;
  const text = Array.isArray(target) ? target.join(',') : String(target ?? '');
  return text.toLowerCase();
}

export class RefreshTokenRotatedException extends UnauthorizedException {
  constructor() {
    super('Refresh token was already rotated.');
  }
}

export type AuthIssueContext = {
  userAgent?: string | null;
  ip?: string | null;
  /** Which first-party client registered (labels consent / attribution; not trusted for auth). */
  client?: 'dashboard' | 'extension';
};

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<ApiConfig, true>,
    @Optional() private readonly securityAudit?: SecurityAuditService,
  ) {}

  async register(input: RegisterDto, ctx: AuthIssueContext = {}): Promise<AuthTokenResponse> {
    const email = input.email.toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) {
      // Equalize timing vs new-user path; avoid confirming which emails exist.
      await bcrypt.hash(input.password, 12);
      throw new ConflictException('Unable to create an account with the provided details.');
    }

    const passwordHash = await bcrypt.hash(input.password, 12);
    const name = input.name?.trim() || null;
    const client = ctx.client ?? 'dashboard';
    // Only an explicit `true` is consent; absent / false = no marketing email.
    const marketingConsent = input.marketingConsent === true;
    const attribution = sanitizeSignupAttribution(input.attribution);
    const consentAt = new Date();

    // Registration races (root cause of an intermittent 500, see below) are resolved here:
    // - concurrent registrations of the SAME email: the unique violation is answered with the
    //   same generic 409 as the existence check above (never a 500);
    // - personal-workspace slug collisions: the slug is derived from the first 16 characters
    //   of the user id (cuid: timestamp + counter + part of the process fingerprint), which can
    //   coincide for registrations in different processes within the same millisecond. The
    //   "is the slug free?" check cannot see another transaction's uncommitted insert, so the
    //   insert may hit the unique index; the whole transaction is retried with a random suffix.
    let user:
      { id: string; email: string; name: string | null; sessionVersion: number } | undefined;
    for (let attempt = 0; attempt < REGISTRATION_SLUG_ATTEMPTS && !user; attempt += 1) {
      try {
        user = await this.createAccount(
          { email, passwordHash, name, client, marketingConsent, attribution, consentAt },
          attempt,
        );
      } catch (error) {
        const target = uniqueViolationTarget(error);
        if (target?.includes('email')) {
          throw new ConflictException('Unable to create an account with the provided details.');
        }
        if (target?.includes('slug') && attempt + 1 < REGISTRATION_SLUG_ATTEMPTS) {
          this.logger.warn({ msg: 'auth.register.slug_collision_retry', attempt });
          continue;
        }
        throw error;
      }
    }
    if (!user) throw new Error('registration did not complete');

    this.securityAudit?.record({
      type: 'auth.register',
      outcome: 'success',
      actorUserId: user.id,
      ip: ctx.ip,
    });

    return this.issueSession(user, ctx);
  }

  /** One registration attempt (user, settings, personal workspace) in a single transaction. */
  private createAccount(
    input: {
      email: string;
      passwordHash: string;
      name: string | null;
      client: 'dashboard' | 'extension';
      marketingConsent: boolean;
      attribution: ReturnType<typeof sanitizeSignupAttribution>;
      consentAt: Date;
    },
    attempt: number,
  ) {
    const { email, passwordHash, name, client, marketingConsent, attribution, consentAt } = input;
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email,
          passwordHash,
          name,
          settings: {
            create: marketingConsent
              ? { marketingEmailConsent: true, marketingConsentUpdatedAt: consentAt }
              : {},
          },
          // First-touch attribution, written once and never overwritten.
          acquisition: { create: { signupClient: client, ...attribution } },
          ...(marketingConsent
            ? {
                marketingConsentEvents: {
                  create: {
                    granted: true,
                    source: client === 'extension' ? 'extension_signup' : 'dashboard_signup',
                    policyVersion: MARKETING_CONSENT_VERSION,
                    createdAt: consentAt,
                  },
                },
              }
            : {}),
        },
        select: { id: true, email: true, name: true, sessionVersion: true },
      });

      const workspaceId = `ws_${created.id}`;
      const base =
        attempt === 0
          ? personalWorkspaceSlug(created.id)
          : `${personalWorkspaceSlug(created.id)}-${randomBytes(3).toString('hex')}`;
      let slug = base;
      let taken = 0;
      while (await tx.workspace.findUnique({ where: { slug } })) {
        taken += 1;
        slug = `${base}-${taken}`;
      }

      await tx.workspace.create({
        data: {
          id: workspaceId,
          name: personalWorkspaceName(created.name, created.email),
          slug,
          status: 'active',
          createdByUserId: created.id,
        },
      });
      await tx.workspaceMembership.create({
        data: {
          id: `wsm_${created.id}`,
          workspaceId,
          userId: created.id,
          role: 'owner',
          status: 'active',
          joinedAt: new Date(),
        },
      });
      await tx.workspaceSubscription.create({
        data: {
          id: `wss_${created.id}`,
          workspaceId,
          provider: 'paddle',
          planId: 'free',
          status: 'none',
        },
      });
      await tx.user.update({
        where: { id: created.id },
        data: { lastWorkspaceId: workspaceId },
      });

      return created;
    });
  }

  async login(input: LoginDto, ctx: AuthIssueContext = {}): Promise<AuthTokenResponse> {
    const email = input.email.toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      // Dummy compare so unknown emails take similar time as bad passwords.
      await bcrypt.compare(input.password, UNKNOWN_USER_PASSWORD_HASH);
      this.securityAudit?.record({
        type: 'auth.login.failure',
        outcome: 'failure',
        email,
        ip: ctx.ip,
        detail: 'unknown_user',
      });
      throw new UnauthorizedException('Invalid email or password.');
    }

    const valid = await bcrypt.compare(input.password, user.passwordHash);
    if (!valid) {
      this.securityAudit?.record({
        type: 'auth.login.failure',
        outcome: 'failure',
        actorUserId: user.id,
        email,
        ip: ctx.ip,
        detail: 'invalid_password',
      });
      throw new UnauthorizedException('Invalid email or password.');
    }

    this.securityAudit?.record({
      type: 'auth.login.success',
      outcome: 'success',
      actorUserId: user.id,
      ip: ctx.ip,
    });

    // The password was checked against `user.passwordHash` a bcrypt-compare ago. The session
    // is issued only if that is still the account's password and session generation — a
    // password reset or logout-all that committed in between wins (see issueSession).
    return this.issueSession(
      {
        id: user.id,
        email: user.email,
        name: user.name,
        sessionVersion: user.sessionVersion,
        verifiedPasswordHash: user.passwordHash,
      },
      ctx,
    );
  }

  /**
   * Rotate refresh token. Reuse of an already-revoked token revokes the whole family.
   */
  async refresh(rawRefreshToken: string, ctx: AuthIssueContext = {}): Promise<AuthTokenResponse> {
    const tokenHash = hashToken(rawRefreshToken);
    const existing = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: {
        user: { select: { id: true, email: true, name: true, sessionVersion: true } },
      },
    });

    if (!existing) {
      throw new UnauthorizedException('Invalid refresh token.');
    }

    if (existing.revokedAt) {
      const rotatedRecently =
        existing.replacedByTokenId !== null &&
        Date.now() - existing.revokedAt.getTime() < REFRESH_ROTATION_GRACE_MS;
      if (rotatedRecently) {
        throw new RefreshTokenRotatedException();
      }
      // Same per-family lock as rotation (adversarial N3): a rotation racing this revocation
      // either commits first (its new token is revoked here) or waits and sees the revocation.
      await this.prisma.$transaction(async (tx) => {
        await lockRefreshFamily(tx, existing.familyId);
        await tx.refreshToken.updateMany({
          where: { familyId: existing.familyId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      });
      await this.prisma.user.update({
        where: { id: existing.userId },
        data: { sessionVersion: { increment: 1 } },
      });
      this.securityAudit?.record({
        type: 'auth.refresh.reuse_detected',
        outcome: 'blocked',
        actorUserId: existing.userId,
        ip: ctx.ip,
      });
      throw new UnauthorizedException('Refresh token reuse detected. Please sign in again.');
    }

    if (existing.expiresAt.getTime() <= Date.now()) {
      await this.prisma.refreshToken.update({
        where: { id: existing.id },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException('Refresh token expired. Please sign in again.');
    }

    const refreshExpiresIn = this.config.get('jwt.refreshExpiresIn', { infer: true });
    const nextRaw = createRefreshToken();
    const nextHash = hashToken(nextRaw);
    const nextId = randomUUID();
    const expiresAt = new Date(
      Date.now() + durationToSeconds(refreshExpiresIn, 7 * 24 * 3600) * 1000,
    );

    // N-14: atomic single-use rotation. Only the request that flips revokedAt from null wins;
    // a concurrent refresh with the same token gets "already rotated" (as within the grace
    // window) and is never issued a second, valid descendant.
    //
    // F-31: the rotation also holds the USER row lock, taken first. Logout-all and password
    // reset start by updating that row (session_version) before they revoke the refresh
    // tokens, so the two serialize: a global revocation either commits first (this rotation
    // then finds its token revoked and issues nothing) or waits for this rotation and then
    // revokes the token it just created. Without it the revocation's snapshot could miss the
    // not-yet-committed new token, which then survived "sign out everywhere".
    const sessionVersion = await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ session_version: number }>>`
        SELECT session_version FROM users WHERE id = ${existing.userId} FOR UPDATE`;
      if (!locked[0]) throw new UnauthorizedException('Invalid refresh token.');
      await lockRefreshFamily(tx, existing.familyId);
      const rotated = await tx.refreshToken.updateMany({
        where: { id: existing.id, revokedAt: null },
        data: { revokedAt: new Date(), replacedByTokenId: nextId },
      });
      // Revoked by a concurrent rotation (same token) or by a global revocation that won.
      if (rotated.count !== 1) {
        const now = await tx.refreshToken.findUnique({
          where: { id: existing.id },
          select: { replacedByTokenId: true },
        });
        if (now?.replacedByTokenId) throw new RefreshTokenRotatedException();
        throw new UnauthorizedException('Session ended. Please sign in again.');
      }
      await tx.refreshToken.create({
        data: {
          id: nextId,
          userId: existing.userId,
          tokenHash: nextHash,
          familyId: existing.familyId,
          expiresAt,
          userAgent: truncate(ctx.userAgent, 512),
          ip: truncate(ctx.ip, 64),
        },
      });
      return locked[0].session_version;
    });

    const accessExpiresIn = this.config.get('jwt.expiresIn', { infer: true });
    // Signed with the version read under the lock (never a value read before a revocation).
    const accessToken = this.jwt.sign(
      { sub: existing.user.id, email: existing.user.email, sv: sessionVersion },
      { expiresIn: accessExpiresIn },
    );

    return {
      accessToken,
      refreshToken: nextRaw,
      expiresIn: durationToSeconds(accessExpiresIn, 900),
      user: {
        id: existing.user.id,
        email: existing.user.email,
        name: existing.user.name,
      },
    };
  }

  /**
   * Invalidate all access JWTs (sessionVersion) and revoke refresh tokens for this user.
   */
  async logout(userId: string, rawRefreshToken?: string | null): Promise<{ ok: true }> {
    if (rawRefreshToken) {
      const tokenHash = hashToken(rawRefreshToken);
      const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });
      if (row && row.userId === userId) {
        await this.prisma.refreshToken.updateMany({
          where: { familyId: row.familyId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
    }

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { sessionVersion: { increment: 1 } },
      }),
      this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    this.securityAudit?.record({
      type: 'auth.logout',
      outcome: 'success',
      actorUserId: userId,
    });

    return { ok: true };
  }

  /**
   * Logout when access JWT is missing/expired but a refresh cookie/body is still present.
   * Looks up the refresh family and revokes it + bumps sessionVersion.
   */
  async logoutByRefreshToken(rawRefreshToken: string): Promise<{ ok: true }> {
    const tokenHash = hashToken(rawRefreshToken);
    const row = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });
    if (!row || row.revokedAt) {
      return { ok: true };
    }
    return this.logout(row.userId, rawRefreshToken);
  }

  /** Revoke every refresh family and bump session — all devices. */
  async logoutAll(userId: string): Promise<{ ok: true }> {
    return this.logout(userId);
  }

  /**
   * Create a session (access JWT + a new refresh-token family).
   *
   * The refresh token is inserted under the USER row lock, the same lock a password reset and
   * logout-all take first — so a global revocation either committed before (and is seen here)
   * or will see this token and revoke it. For a login (`verifiedPasswordHash` set) the insert
   * is refused when the credentials that were just verified are no longer the account's: a
   * reset that committed while bcrypt was running must not be followed by a session minted
   * from the OLD password. The JWT is signed with the session version read under the lock.
   */
  private async issueSession(
    user: {
      id: string;
      email: string;
      name: string | null;
      sessionVersion: number;
      verifiedPasswordHash?: string;
    },
    ctx: AuthIssueContext,
  ): Promise<AuthTokenResponse> {
    const accessExpiresIn = this.config.get('jwt.expiresIn', { infer: true });
    const refreshExpiresIn = this.config.get('jwt.refreshExpiresIn', { infer: true });

    const rawRefresh = createRefreshToken();
    const familyId = randomUUID();
    const sessionVersion = await this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ session_version: number; password_hash: string }>>`
        SELECT session_version, password_hash FROM users WHERE id = ${user.id} FOR UPDATE`;
      const current = locked[0];
      if (!current) throw new UnauthorizedException('Invalid email or password.');
      if (
        user.verifiedPasswordHash !== undefined &&
        current.password_hash !== user.verifiedPasswordHash
      ) {
        throw new UnauthorizedException('Invalid email or password.');
      }
      await tx.refreshToken.create({
        data: {
          userId: user.id,
          tokenHash: hashToken(rawRefresh),
          familyId,
          expiresAt: new Date(
            Date.now() + durationToSeconds(refreshExpiresIn, 7 * 24 * 3600) * 1000,
          ),
          userAgent: truncate(ctx.userAgent, 512),
          ip: truncate(ctx.ip, 64),
        },
      });
      return current.session_version;
    });
    const accessToken = this.jwt.sign(
      { sub: user.id, email: user.email, sv: sessionVersion },
      { expiresIn: accessExpiresIn },
    );

    return {
      accessToken,
      refreshToken: rawRefresh,
      expiresIn: durationToSeconds(accessExpiresIn, 900),
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
    };
  }
}

/** Precomputed bcrypt hash used only to equalize login timing for unknown emails. */
const UNKNOWN_USER_PASSWORD_HASH = '$2b$12$KBdPyzLfXY3FRTs0XEdYoelnQwRMSk2yMtVqwC/ipmDvhMnghZ7Zq';

function createRefreshToken(): string {
  return randomBytes(48).toString('base64url');
}

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function truncate(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  return value.length <= max ? value : value.slice(0, max);
}
