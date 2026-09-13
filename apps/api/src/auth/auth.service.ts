import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { personalWorkspaceName, personalWorkspaceSlug } from '@project-x/shared';

import type { AuthTokenResponse } from '@project-x/types';

import type { ApiConfig } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import type { LoginDto, RegisterDto } from './dto/auth.dto';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<ApiConfig, true>,
  ) {}

  async register(input: RegisterDto): Promise<AuthTokenResponse> {
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

    return this.toAuthResponse(user);
  }

  async login(input: LoginDto): Promise<AuthTokenResponse> {
    const email = input.email.toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      throw new UnauthorizedException('Invalid email or password.');
    }

    const valid = await bcrypt.compare(input.password, user.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Invalid email or password.');
    }

    return this.toAuthResponse({
      id: user.id,
      email: user.email,
      name: user.name,
      sessionVersion: user.sessionVersion,
    });
  }

  /**
   * Invalidate all outstanding JWTs for this user by bumping sessionVersion.
   * Clients must also clear local token storage.
   */
  async logout(userId: string): Promise<{ ok: true }> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { sessionVersion: { increment: 1 } },
    });
    return { ok: true };
  }

  private toAuthResponse(user: {
    id: string;
    email: string;
    name: string | null;
    sessionVersion: number;
  }): AuthTokenResponse {
    const expiresIn = this.config.get('jwt.expiresIn', { infer: true });
    const accessToken = this.jwt.sign(
      { sub: user.id, email: user.email, sv: user.sessionVersion },
      { expiresIn },
    );

    return {
      accessToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
    };
  }
}
