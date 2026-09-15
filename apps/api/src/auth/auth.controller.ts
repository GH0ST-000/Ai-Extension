import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';

import type { ApiConfig } from '../config/configuration';
import { RateLimit, RateLimitGuard } from '../common/security/rate-limit.guard';
import {
  clearAuthCookies,
  durationToMs,
  readCookie,
  REFRESH_COOKIE,
  setAuthCookies,
} from './auth-cookies';
import { AuthService } from './auth.service';
import { CurrentUser } from './current-user.decorator';
import { LoginDto, RefreshDto, RegisterDto } from './dto/auth.dto';
import { JwtAuthGuard } from './jwt-auth.guard';
import type { AuthRequestUser } from './jwt.strategy';
import { OptionalJwtAuthGuard } from './optional-jwt-auth.guard';

@Controller('auth')
@UseGuards(RateLimitGuard)
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService<ApiConfig, true>,
  ) {}

  @Post('register')
  @HttpCode(201)
  @RateLimit({ bucket: 'auth', limit: 10, windowSeconds: 60 })
  async register(
    @Body() body: RegisterDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.register(body, requestContext(req));
    this.writeSessionCookies(res, result.accessToken, result.refreshToken!);
    return result;
  }

  @Post('login')
  @HttpCode(200)
  @RateLimit({ bucket: 'auth', limit: 20, windowSeconds: 60 })
  async login(
    @Body() body: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.login(body, requestContext(req));
    this.writeSessionCookies(res, result.accessToken, result.refreshToken!);
    return result;
  }

  @Post('refresh')
  @HttpCode(200)
  @RateLimit({ bucket: 'auth', limit: 60, windowSeconds: 60 })
  async refresh(
    @Body() body: RefreshDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const raw = body.refreshToken?.trim() || readCookie(req, REFRESH_COOKIE);
    if (!raw) {
      clearAuthCookies(res, this.cookieSecure());
      throw new UnauthorizedException('Refresh token required.');
    }
    try {
      const result = await this.authService.refresh(raw, requestContext(req));
      this.writeSessionCookies(res, result.accessToken, result.refreshToken!);
      return result;
    } catch (error) {
      clearAuthCookies(res, this.cookieSecure());
      throw error;
    }
  }

  @Post('logout')
  @HttpCode(200)
  @UseGuards(OptionalJwtAuthGuard)
  async logout(
    @CurrentUser() user: AuthRequestUser | undefined,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const refresh = readCookie(req, REFRESH_COOKIE);
    if (user) {
      await this.authService.logout(user.id, refresh);
    }
    clearAuthCookies(res, this.cookieSecure());
    return { ok: true as const };
  }

  @Post('logout-all')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  async logoutAll(@CurrentUser() user: AuthRequestUser, @Res({ passthrough: true }) res: Response) {
    await this.authService.logoutAll(user.id);
    clearAuthCookies(res, this.cookieSecure());
    return { ok: true as const };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: AuthRequestUser) {
    return { user };
  }

  private writeSessionCookies(res: Response, accessToken: string, refreshToken: string): void {
    const accessExpiresIn = this.config.get('jwt.expiresIn', { infer: true });
    const refreshExpiresIn = this.config.get('jwt.refreshExpiresIn', { infer: true });
    setAuthCookies(
      res,
      { accessToken, refreshToken },
      {
        secure: this.cookieSecure(),
        accessMaxAgeMs: durationToMs(accessExpiresIn, 15 * 60_000),
        refreshMaxAgeMs: durationToMs(refreshExpiresIn, 7 * 86_400_000),
      },
    );
  }

  private cookieSecure(): boolean {
    return this.config.get('nodeEnv', { infer: true }) === 'production';
  }
}

function requestContext(req: Request): { userAgent?: string; ip?: string } {
  return {
    userAgent:
      typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined,
    ip: req.ip,
  };
}
