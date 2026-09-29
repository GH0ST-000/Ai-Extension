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
import type { AuthTokenResponse } from '@project-x/types';

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
import { Public } from './public.decorator';

/** Extension must opt in to receive JWTs in the JSON body; dashboard uses cookies only. */
const EXTENSION_CLIENT_HEADER = 'x-project-x-client';

@Controller('auth')
@UseGuards(RateLimitGuard)
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService<ApiConfig, true>,
  ) {}

  @Public()
  @Post('register')
  @HttpCode(201)
  @RateLimit({ bucket: 'auth', limit: 10, windowSeconds: 60 })
  async register(
    @Body() body: RegisterDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.register(body, requestContext(req));
    this.writeSessionCookies(res, result.accessToken!, result.refreshToken!);
    return this.shapeAuthResponse(req, result);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @RateLimit({ bucket: 'auth', limit: 20, windowSeconds: 60 })
  async login(
    @Body() body: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.login(body, requestContext(req));
    this.writeSessionCookies(res, result.accessToken!, result.refreshToken!);
    return this.shapeAuthResponse(req, result);
  }

  @Public()
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
      this.writeSessionCookies(res, result.accessToken!, result.refreshToken!);
      return this.shapeAuthResponse(req, result);
    } catch (error) {
      clearAuthCookies(res, this.cookieSecure());
      throw error;
    }
  }

  @Public()
  @Post('logout')
  @HttpCode(200)
  @RateLimit({ bucket: 'auth', limit: 60, windowSeconds: 60 })
  @UseGuards(OptionalJwtAuthGuard)
  async logout(
    @CurrentUser() user: AuthRequestUser | undefined,
    @Body() body: RefreshDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const refresh = body.refreshToken?.trim() || readCookie(req, REFRESH_COOKIE);
    if (user) {
      await this.authService.logout(user.id, refresh);
    } else if (refresh) {
      await this.authService.logoutByRefreshToken(refresh);
    }
    clearAuthCookies(res, this.cookieSecure());
    return { ok: true as const };
  }

  @Post('logout-all')
  @HttpCode(200)
  @RateLimit({ bucket: 'auth', limit: 30, windowSeconds: 60 })
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

  private shapeAuthResponse(req: Request, result: AuthTokenResponse): AuthTokenResponse {
    if (wantsBodyTokens(req)) {
      return result;
    }
    return {
      expiresIn: result.expiresIn,
      user: result.user,
    };
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

function wantsBodyTokens(req: Request): boolean {
  const header = req.headers[EXTENSION_CLIENT_HEADER];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value === 'string' && value.trim().toLowerCase() === 'extension') {
    return true;
  }
  const origin = req.headers.origin;
  // Extension pages send chrome-extension:// Origin; service-worker fetch often omits Origin.
  if (typeof origin === 'string' && origin.startsWith('chrome-extension://')) {
    return true;
  }
  if (!origin) {
    return true;
  }
  return false;
}

function requestContext(req: Request): { userAgent?: string; ip?: string } {
  return {
    userAgent:
      typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined,
    ip: req.ip,
  };
}
