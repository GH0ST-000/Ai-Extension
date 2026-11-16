import { HttpException, HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'node:crypto';
import { APP_NAME } from '@project-x/shared';

import type { ApiConfig } from '../config/configuration';
import { MailService } from '../mail/mail.service';
import { SecurityAuditService } from '../observability/security-audit.service';
import { PrismaService } from '../prisma/prisma.service';
import { buildPasswordResetEmail, PASSWORD_RESET_TTL_MINUTES } from './password-reset.email';

export const PASSWORD_RESET_TTL_MS = PASSWORD_RESET_TTL_MINUTES * 60 * 1000;
/** A new reset email for the same account at most once a minute… */
export const PASSWORD_RESET_COOLDOWN_MS = 60 * 1000;
/** …and at most this many per hour (limits inbox flooding and outstanding tokens). */
export const PASSWORD_RESET_MAX_PER_HOUR = 5;
/** Same cost as registration and login. */
const BCRYPT_COST = 12;

/** The only response to a reset request, whatever happened (no account enumeration). */
export const PASSWORD_RESET_REQUEST_MESSAGE =
  'If an account exists for that email, we sent a link to reset the password. It expires in 30 minutes.';

export type ResetRequestOutcome =
  'sent' | 'no_account' | 'throttled' | 'mail_not_configured' | 'mail_failed';

/** 32 random bytes → 43 base64url characters. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export class PasswordResetInvalidException extends HttpException {
  constructor() {
    super(
      {
        statusCode: HttpStatus.BAD_REQUEST,
        code: 'PASSWORD_RESET_INVALID',
        message: 'This reset link is invalid or has expired. Request a new one.',
      },
      HttpStatus.BAD_REQUEST,
    );
  }
}

/** SHA-256 of a 256-bit random token: the token is not guessable, so a fast hash is enough. */
export function hashResetToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Password reset.
 *
 * Request: answered immediately with the same message for every email; the account lookup,
 * token issue and email are processed afterwards, so neither the response nor its timing
 * depends on whether the account exists. Tokens: 256-bit random, only the hash is stored,
 * 30-minute expiry, single use; issuing a new one revokes older ones.
 *
 * Confirm: the token is consumed with a conditional update inside the same transaction that
 * changes the password, bumps `sessionVersion` (invalidates access tokens) and revokes every
 * refresh token — concurrent confirmations cannot both succeed. Never logs tokens or links.
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly config: ConfigService<ApiConfig, true>,
    @Optional() private readonly securityAudit?: SecurityAuditService,
  ) {}

  /** Accepts the request and processes it after the response (never throws). */
  requestReset(emailRaw: string, ctx: { ip?: string | null } = {}): void {
    void this.processResetRequest(emailRaw, ctx).catch((error: unknown) => {
      this.logger.error({
        msg: 'password_reset.request_failed',
        errorName: error instanceof Error ? error.name : 'unknown',
      });
    });
  }

  /** The actual work of a reset request (exported for tests). */
  async processResetRequest(
    emailRaw: string,
    ctx: { ip?: string | null } = {},
  ): Promise<ResetRequestOutcome> {
    const email = emailRaw.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, name: true, email: true },
    });
    if (!user) {
      this.audit('auth.password_reset.requested', 'blocked', undefined, email, ctx.ip);
      return 'no_account';
    }

    const now = new Date();
    // Short transaction, serialized per user: no network call happens inside it.
    const issued = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`password_reset:${user.id}`}, 0))::text`;
      const recent = await tx.passwordResetToken.findMany({
        where: { userId: user.id, createdAt: { gte: new Date(now.getTime() - 60 * 60 * 1000) } },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      const latest = recent[0];
      if (latest && now.getTime() - latest.createdAt.getTime() < PASSWORD_RESET_COOLDOWN_MS) {
        return null;
      }
      if (recent.length >= PASSWORD_RESET_MAX_PER_HOUR) return null;
      // Only the newest link works.
      await tx.passwordResetToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: now },
      });
      const token = randomBytes(32).toString('base64url');
      const row = await tx.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: hashResetToken(token),
          expiresAt: new Date(now.getTime() + PASSWORD_RESET_TTL_MS),
        },
        select: { id: true },
      });
      return { token, id: row.id };
    });
    if (!issued) {
      this.audit('auth.password_reset.requested', 'blocked', user.id, user.email, ctx.ip);
      return 'throttled';
    }

    const email_ = buildPasswordResetEmail({
      appName: APP_NAME,
      resetUrl: this.resetUrl(issued.token),
      name: user.name,
    });
    const result = await this.mail.send({
      to: user.email,
      subject: email_.subject,
      html: email_.html,
      text: email_.text,
      template: 'password_reset',
    });
    if (!result.delivered) {
      // The link never reached the user: revoke it rather than leave a live token behind.
      await this.prisma.passwordResetToken
        .updateMany({ where: { id: issued.id, usedAt: null }, data: { usedAt: new Date() } })
        .catch(() => undefined);
      this.audit('auth.password_reset.requested', 'failure', user.id, user.email, ctx.ip);
      return result.reason === 'not_configured' ? 'mail_not_configured' : 'mail_failed';
    }
    this.audit('auth.password_reset.requested', 'success', user.id, user.email, ctx.ip);
    return 'sent';
  }

  /**
   * Set a new password with a reset token. Signs the user out everywhere; does not sign in.
   * Invalid, expired and used tokens all fail the same way.
   */
  async confirmReset(
    token: string,
    newPassword: string,
    ctx: { ip?: string | null } = {},
  ): Promise<{ ok: true }> {
    if (!TOKEN_PATTERN.test(token)) throw new PasswordResetInvalidException();
    const tokenHash = hashResetToken(token);
    const now = new Date();

    // Cheap check first, so invalid tokens never cost a bcrypt hash.
    const pending = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash },
      select: { userId: true, usedAt: true, expiresAt: true },
    });
    if (!pending || pending.usedAt || pending.expiresAt.getTime() <= now.getTime()) {
      throw new PasswordResetInvalidException();
    }

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);

    await this.prisma.$transaction(async (tx) => {
      const consumedAt = new Date();
      // Atomic consumption: only one request can flip used_at from NULL for a live token.
      const consumed = await tx.passwordResetToken.updateMany({
        where: { tokenHash, usedAt: null, expiresAt: { gt: consumedAt } },
        data: { usedAt: consumedAt },
      });
      if (consumed.count !== 1) throw new PasswordResetInvalidException();
      await tx.user.update({
        where: { id: pending.userId },
        data: { passwordHash, sessionVersion: { increment: 1 } },
      });
      await tx.refreshToken.updateMany({
        where: { userId: pending.userId, revokedAt: null },
        data: { revokedAt: consumedAt },
      });
      await tx.passwordResetToken.updateMany({
        where: { userId: pending.userId, usedAt: null },
        data: { usedAt: consumedAt },
      });
    });

    this.audit('auth.password_reset.completed', 'success', pending.userId, undefined, ctx.ip);
    return { ok: true };
  }

  private resetUrl(token: string): string {
    const base = this.config.get('appBaseUrl', { infer: true }).replace(/\/+$/, '');
    // Fragment, not query: never sent to servers, proxies, logs or the Referer header.
    return `${base}/reset-password#token=${token}`;
  }

  private audit(
    type: 'auth.password_reset.requested' | 'auth.password_reset.completed',
    outcome: 'success' | 'failure' | 'blocked',
    actorUserId: string | undefined,
    email: string | undefined,
    ip: string | null | undefined,
  ): void {
    this.securityAudit?.record({
      type,
      outcome,
      ...(actorUserId ? { actorUserId } : {}),
      ...(email ? { email } : {}),
      ip: ip ?? null,
    });
  }
}
