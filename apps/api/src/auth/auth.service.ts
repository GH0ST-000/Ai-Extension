import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';

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
    const user = await this.prisma.user.create({
      data: {
        email,
        passwordHash,
        name: input.name?.trim() || null,
        settings: {
          create: {},
        },
      },
      select: { id: true, email: true, name: true },
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
    });
  }

  private toAuthResponse(user: {
    id: string;
    email: string;
    name: string | null;
  }): AuthTokenResponse {
    const expiresIn = this.config.get('jwt.expiresIn', { infer: true });
    const accessToken = this.jwt.sign({ sub: user.id, email: user.email }, { expiresIn });

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
