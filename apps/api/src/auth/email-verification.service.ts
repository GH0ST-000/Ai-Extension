import { HttpException, HttpStatus, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import { APP_NAME } from '@project-x/shared';

import type { ApiConfig } from '../config/configuration';
import { MailService } from '../mail/mail.service';
import { SecurityAuditService } from '../observability/security-audit.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  buildEmailVerificationEmail,
  EMAIL_VERIFICATION_TTL_HOURS,
} from './email-verification.email';

export const EMAIL_VERIFICATION_TTL_MS = EMAIL_VERIFICATION_TTL_HOURS * 60 * 60 * 1000;
/** A new verification email at most once a minute… */
export const EMAIL_VERIFICATION_COOLDOWN_MS = 60 * 1000;
/** …and at most this many per hour per account. */
export const EMAIL_VERIFICATION_MAX_PER_HOUR = 5;

/** 32 random bytes → 43 base64url characters. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export type VerificationIssueOutcome =
  'sent' | 'already_verified' | 'throttled' | 'mail_not_configured' | 'mail_failed';

export type EmailVerificationErrorCode =
  'EMAIL_VERIFICATION_INVALID' | 'EMAIL_VERIFICATION_EXPIRED' | 'EMAIL_VERIFICATION_WRONG_ACCOUNT';

const VERIFICATION_ERRORS: Record<EmailVerificationErrorCode, { status: number; message: string }> =
  {
    EMAIL_VERIFICATION_INVALID: {
      status: HttpStatus.BAD_REQUEST,
      message: 'This verification link is invalid or was already used.',
    },
    EMAIL_VERIFICATION_EXPIRED: {
      status: HttpStatus.BAD_REQUEST,
      message: 'This verification link has expired. Request a new one.',
    },
    EMAIL_VERIFICATION_WRONG_ACCOUNT: {
      status: HttpStatus.FORBIDDEN,
      message:
        'This verification link belongs to a different account. Sign in with the account it was sent for, then open the link again.',
    },
  };

export class EmailVerificationException extends HttpException {
  constructor(code: EmailVerificationErrorCode) {
    const { status, message } = VERIFICATION_ERRORS[code];
    super({ statusCode: status, code, message }, status);
  }
}

/** SHA-256 of a 256-bit random token (not guessable, so a fast hash is enough). */
export function hashVerificationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Decision A — email ownership verification.
 *
 * Issue: 256-bit random token, only its hash stored, bound to the address it was sent to,
 * 24 h expiry, single use; issuing a new one revokes older ones; cooldown + hourly cap per
 * account (serialized per user, no network call inside the transaction). If the email cannot
 * be delivered, the token is revoked immediately — no live token without a delivered link.
 *
 * Confirm (F-05): the link proves that someone can read the mailbox; it does NOT prove that the
 * person holding the account's password can. Whoever registers an address gets the session,
 * so a token-only confirmation let an attacker pre-register a victim's address and have the
 * victim's click verify the ATTACKER's account. Confirmation therefore needs both proofs: the
 * token (mailbox) and a session of the very account the token was issued for (credentials).
 * A victim cannot sign in to an account they did not create — they would reset the password,
 * which signs the attacker out everywhere — and an attacker never sees the token.
 *
 * The link carries the token in the URL fragment (never sent to servers, logs or
 * Referer); the client posts it in a JSON body. Consumption is one conditional update in the
 * transaction that marks the user verified, so concurrent confirmations cannot double-use it,
 * and only while the token's address is still the user's email. Tokens are never logged.
 */
@Injectable()
export class EmailVerificationService {
  private readonly logger = new Logger(EmailVerificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly config: ConfigService<ApiConfig, true>,
    @Optional() private readonly securityAudit?: SecurityAuditService,
  ) {}

  async status(userId: string): Promise<{ email: string; verified: boolean }> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true, emailVerifiedAt: true },
    });
    return { email: user.email, verified: user.emailVerifiedAt !== null };
  }

  /** Issue a link for `userId` and email it (never throws). */
  async issue(userId: string): Promise<VerificationIssueOutcome> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, emailVerifiedAt: true },
    });
    if (!user) return 'throttled';
    if (user.emailVerifiedAt) return 'already_verified';

    const now = new Date();
    const issued = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`email_verification:${user.id}`}, 0))::text`;
      const recent = await tx.emailVerificationToken.findMany({
        where: { userId: user.id, createdAt: { gte: new Date(now.getTime() - 60 * 60 * 1000) } },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      const latest = recent[0];
      if (latest && now.getTime() - latest.createdAt.getTime() < EMAIL_VERIFICATION_COOLDOWN_MS) {
        return null;
      }
      if (recent.length >= EMAIL_VERIFICATION_MAX_PER_HOUR) return null;
      await tx.emailVerificationToken.updateMany({
        where: { userId: user.id, usedAt: null },
        data: { usedAt: now },
      });
      const token = randomBytes(32).toString('base64url');
      const row = await tx.emailVerificationToken.create({
        data: {
          userId: user.id,
          email: user.email,
          tokenHash: hashVerificationToken(token),
          expiresAt: new Date(now.getTime() + EMAIL_VERIFICATION_TTL_MS),
        },
        select: { id: true },
      });
      return { token, id: row.id };
    });
    if (!issued) return 'throttled';

    const message = buildEmailVerificationEmail({
      appName: APP_NAME,
      verifyUrl: this.verifyUrl(issued.token),
      name: user.name,
    });
    const result = await this.mail.send({
      to: user.email,
      subject: message.subject,
      html: message.html,
      text: message.text,
      template: 'email_verification',
    });
    if (!result.delivered) {
      await this.prisma.emailVerificationToken
        .updateMany({ where: { id: issued.id, usedAt: null }, data: { usedAt: new Date() } })
        .catch(() => undefined);
      // Observable without the token or address: the user id and the transport's reason.
      this.logger.warn({
        msg: 'email_verification.delivery_failed',
        userId: user.id,
        reason: result.reason,
        tokenRevoked: true,
      });
      return result.reason === 'not_configured' ? 'mail_not_configured' : 'mail_failed';
    }
    return 'sent';
  }

  /** Issue after registration, without delaying or failing the registration response. */
  issueInBackground(userId: string): void {
    void this.issue(userId).catch((error: unknown) =>
      this.logger.error({
        msg: 'email_verification.issue_failed',
        errorName: error instanceof Error ? error.name : 'unknown',
      }),
    );
  }

  /**
   * Mark the token's user verified. `actingUserId` is the authenticated caller: a token of
   * another account is refused WITHOUT being consumed (its owner can still use it).
   */
  async confirm(token: string, actingUserId: string): Promise<{ verified: true }> {
    if (!TOKEN_PATTERN.test(token))
      throw new EmailVerificationException('EMAIL_VERIFICATION_INVALID');
    const tokenHash = hashVerificationToken(token);
    const pending = await this.prisma.emailVerificationToken.findUnique({
      where: { tokenHash },
      select: { userId: true, email: true, usedAt: true, expiresAt: true },
    });
    if (!pending || pending.usedAt) {
      throw new EmailVerificationException('EMAIL_VERIFICATION_INVALID');
    }
    if (pending.expiresAt.getTime() <= Date.now()) {
      throw new EmailVerificationException('EMAIL_VERIFICATION_EXPIRED');
    }
    if (pending.userId !== actingUserId) {
      try {
        this.securityAudit?.record({
          type: 'auth.email.verification_wrong_account',
          outcome: 'blocked',
          actorUserId: actingUserId,
        });
      } catch {
        // auditing never breaks verification
      }
      throw new EmailVerificationException('EMAIL_VERIFICATION_WRONG_ACCOUNT');
    }
    await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      // Atomic single use: only one request can flip used_at for a live token.
      const consumed = await tx.emailVerificationToken.updateMany({
        where: { tokenHash, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (consumed.count !== 1) throw new EmailVerificationException('EMAIL_VERIFICATION_INVALID');
      // Bound to the address the link was sent to.
      const updated = await tx.user.updateMany({
        where: { id: pending.userId, email: pending.email },
        data: { emailVerifiedAt: now },
      });
      if (updated.count !== 1) throw new EmailVerificationException('EMAIL_VERIFICATION_INVALID');
      await tx.emailVerificationToken.updateMany({
        where: { userId: pending.userId, usedAt: null },
        data: { usedAt: now },
      });
    });
    try {
      this.securityAudit?.record({
        type: 'auth.email.verified',
        outcome: 'success',
        actorUserId: pending.userId,
      });
    } catch {
      // auditing never breaks verification
    }
    return { verified: true };
  }

  private verifyUrl(token: string): string {
    const base = this.config.get('appBaseUrl', { infer: true }).replace(/\/+$/, '');
    // Fragment, not query: never sent to servers, proxies, logs or the Referer header.
    return `${base}/verify-email#token=${token}`;
  }
}
