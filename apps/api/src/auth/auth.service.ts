import { ConflictException, Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { personalWorkspaceName, personalWorkspaceSlug } from '@project-x/shared';

import type { AuthTokenResponse } from '@project-x/types';

import type { ApiConfig } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import { durationToSeconds } from './auth-cookies';
import type { LoginDto, RegisterDto } from './dto/auth.dto';
import { SecurityAuditService } from '../observability/security-audit.service';

export type AuthIssueContext = {
  userAgent?: string | null;
  ip?: string | null;
};

@Injectable()
export class AuthService {
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
      throw new ConflictException('An account with this email already exists.');
    }

    const passwordHash = await bcrypt.hash(input.password, 12);
    const name = input.name?.trim() || null;

    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email,
          passwordHash,
          name,
          settings: {
            create: {},
          },
        },
        select: { id: true, email: true, name: true, sessionVersion: true },
      });

      const workspaceId = `ws_${created.id}`;
      let slug = personalWorkspaceSlug(created.id);
      let attempt = 0;
      while (await tx.workspace.findUnique({ where: { slug } })) {
        attempt += 1;
        slug = `${personalWorkspaceSlug(created.id)}-${attempt}`;
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

    this.securityAudit?.record({
      type: 'auth.register',
      outcome: 'success',
      actorUserId: user.id,
      ip: ctx.ip,
    });

    return this.issueSession(user, ctx);
  }

  async login(input: LoginDto, ctx: AuthIssueContext = {}): Promise<AuthTokenResponse> {
    const email = input.email.toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
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

    return this.issueSession(
      {
        id: user.id,
        email: user.email,
        name: user.name,
        sessionVersion: user.sessionVersion,
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
      await this.prisma.refreshToken.updateMany({
        where: { familyId: existing.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
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

    await this.prisma.$transaction([
      this.prisma.refreshToken.update({
        where: { id: existing.id },
        data: { revokedAt: new Date(), replacedByTokenId: nextId },
      }),
      this.prisma.refreshToken.create({
        data: {
          id: nextId,
          userId: existing.userId,
          tokenHash: nextHash,
          familyId: existing.familyId,
          expiresAt,
          userAgent: truncate(ctx.userAgent, 512),
          ip: truncate(ctx.ip, 64),
        },
      }),
    ]);

    const accessExpiresIn = this.config.get('jwt.expiresIn', { infer: true });
    const accessToken = this.jwt.sign(
      { sub: existing.user.id, email: existing.user.email, sv: existing.user.sessionVersion },
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

  /** Revoke every refresh family and bump session — all devices. */
  async logoutAll(userId: string): Promise<{ ok: true }> {
    return this.logout(userId);
  }

  private async issueSession(
    user: { id: string; email: string; name: string | null; sessionVersion: number },
    ctx: AuthIssueContext,
  ): Promise<AuthTokenResponse> {
    const accessExpiresIn = this.config.get('jwt.expiresIn', { infer: true });
    const refreshExpiresIn = this.config.get('jwt.refreshExpiresIn', { infer: true });
    const accessToken = this.jwt.sign(
      { sub: user.id, email: user.email, sv: user.sessionVersion },
      { expiresIn: accessExpiresIn },
    );

    const rawRefresh = createRefreshToken();
    const familyId = randomUUID();
    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashToken(rawRefresh),
        familyId,
        expiresAt: new Date(Date.now() + durationToSeconds(refreshExpiresIn, 7 * 24 * 3600) * 1000),
        userAgent: truncate(ctx.userAgent, 512),
        ip: truncate(ctx.ip, 64),
      },
    });

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
