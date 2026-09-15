import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy, type JwtFromRequestFunction } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

import type { ApiConfig } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import { ACCESS_COOKIE, readCookie } from './auth-cookies';

export type JwtPayload = {
  sub: string;
  email: string;
  /** Session version — must match User.sessionVersion. */
  sv?: number;
};

export type AuthRequestUser = {
  id: string;
  email: string;
  name: string | null;
};

const fromAccessCookie: JwtFromRequestFunction = (req: Request) => readCookie(req, ACCESS_COOKIE);

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService<ApiConfig, true>,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        fromAccessCookie,
      ]),
      ignoreExpiration: false,
      secretOrKey: config.get('jwt.secret', { infer: true }),
    });
  }

  async validate(payload: JwtPayload): Promise<AuthRequestUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, name: true, sessionVersion: true },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid authentication token.');
    }

    const tokenVersion = typeof payload.sv === 'number' ? payload.sv : 0;
    if (tokenVersion !== user.sessionVersion) {
      throw new UnauthorizedException('Session has expired. Please sign in again.');
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
    };
  }
}
