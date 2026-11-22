import { createHash } from 'node:crypto';

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
import { RateLimiter, rateLimitAddressKey } from '../common/security/rate-limiter';
import { RedisService } from '../redis/redis.service';
import {
  clearAuthCookies,
  durationToMs,
  readCookie,
  REFRESH_COOKIE,
  setAuthCookies,
} from './auth-cookies';
import { AuthService, RefreshTokenRotatedException } from './auth.service';
import { CurrentUser } from './current-user.decorator';
import {
  LoginDto,
  EmailVerificationConfirmDto,
  PasswordResetConfirmDto,
  PasswordResetRequestDto,
  RefreshDto,
  RegisterDto,
} from './dto/auth.dto';
import { PASSWORD_RESET_REQUEST_MESSAGE, PasswordResetService } from './password-reset.service';
import { EmailVerificationService } from './email-verification.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import type { AuthRequestUser } from './jwt.strategy';
import { OptionalJwtAuthGuard } from './optional-jwt-auth.guard';
import { Public } from './public.decorator';
import { AuthRequestGuard } from './auth-request.guard';

/**
 * Sent by the extension. Labels the signup client only (attribution); it is caller-supplied
 * and grants nothing — see wantsBodyTokens (F-13).
 */
const EXTENSION_CLIENT_HEADER = 'x-project-x-client';

/** N-15 / F-15: login attempts per account FROM ONE CLIENT ADDRESS per window. */
export const LOGIN_ATTEMPTS_PER_ACCOUNT = 10;
/** F-15: ceiling per account across all client addresses (distributed guessing). */
export const LOGIN_ATTEMPTS_PER_ACCOUNT_ALL_CLIENTS = 50;
const LOGIN_ACCOUNT_WINDOW_SECONDS = 15 * 60;

@Controller('auth')
// AuthRequestGuard first: CSRF rejections (wrong Content-Type / untrusted Origin) are cheap and
// must not consume a legitimate user's rate-limit bucket.
@UseGuards(AuthRequestGuard, RateLimitGuard)
export class AuthController {
  private readonly accountLimiter: RateLimiter;

  constructor(
    private readonly authService: AuthService,
    private readonly config: ConfigService<ApiConfig, true>,
    private readonly passwordReset: PasswordResetService,
    redis: RedisService,
    private readonly emailVerification: EmailVerificationService,
  ) {
    this.accountLimiter = new RateLimiter(redis);
  }

  /**
   * Always 202 with the same body: whether the email belongs to an account, was throttled, or
   * the email provider failed is never revealed. The work runs after the response.
   */
  @Public()
  @Post('password-reset/request')
  @HttpCode(202)
  @RateLimit({ bucket: 'password_reset', limit: 5, windowSeconds: 900 })
  requestPasswordReset(@Body() body: PasswordResetRequestDto, @Req() req: Request) {
    this.passwordReset.requestReset(body.email, requestContext(req));
    return { ok: true as const, message: PASSWORD_RESET_REQUEST_MESSAGE };
  }

  /** Sets the new password and signs out every session. Does not sign in. */
  @Public()
  @Post('password-reset/confirm')
  @HttpCode(200)
  @RateLimit({ bucket: 'password_reset_confirm', limit: 10, windowSeconds: 900 })
  async confirmPasswordReset(@Body() body: PasswordResetConfirmDto, @Req() req: Request) {
    return this.passwordReset.confirmReset(body.token, body.newPassword, requestContext(req));
  }

  /** Decision A: the caller's own verification state (for the dashboard). */
  @Get('email-verification')
  @UseGuards(JwtAuthGuard)
  emailVerificationStatus(@CurrentUser() user: AuthRequestUser) {
    return this.emailVerification.status(user.id);
  }

  /**
   * Decision A: send a new verification link to the caller's own address. Rate limited here
   * and in the service (cooldown + hourly cap). The outcome concerns the caller's own account
   * only, so it is returned (no enumeration of other addresses is possible).
   */
  @Post('email-verification/resend')
  @HttpCode(202)
  @UseGuards(JwtAuthGuard)
  @RateLimit({ bucket: 'email_verification', limit: 5, windowSeconds: 3600 })
  async resendEmailVerification(@CurrentUser() user: AuthRequestUser) {
    return { status: await this.emailVerification.issue(user.id) };
  }

  /**
   * Decision A + F-05: confirm with the token from the link, signed in as the account the link
   * was issued for (any device: sign in there first). Not public — a mailbox click alone must
   * not verify an account whose credentials belong to someone else.
   */
  @Post('email-verification/confirm')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @RateLimit({ bucket: 'email_verification_confirm', limit: 10, windowSeconds: 900 })
  confirmEmailVerification(
    @CurrentUser() user: AuthRequestUser,
    @Body() body: EmailVerificationConfirmDto,
  ) {
    return this.emailVerification.confirm(body.token, user.id);
  }

  @Public()
  @Post('register')
  @HttpCode(201)
  // Decision 1 (account multiplication): besides the burst limit, at most 20 registrations
  // (and so 20 verification emails) per client IP per 24 h. Expires; not a ban.
  @RateLimit({
    bucket: 'auth',
    limit: 10,
    windowSeconds: 60,
    sustained: { bucket: 'register_daily', limit: 20, windowSeconds: 86_400 },
  })
  async register(
    @Body() body: RegisterDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.register(body, {
      ...requestContext(req),
      client: isExtensionClient(req) ? 'extension' : 'dashboard',
    });
    this.writeSessionCookies(res, result.accessToken!, result.refreshToken!);
    // Decision A: verification link sent after the response (never fails registration).
    this.emailVerification.issueInBackground(result.user.id);
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
    // N-15: per-account throttling on top of the per-IP bucket (credential stuffing from many
    // IPs). Keyed by a hash of the normalized email; applied identically to every email —
    // existing or not — with the same 429, so it reveals nothing about accounts.
    //
    // F-15: the tight budget is per account AND client address. Keyed on the account alone, it
    // let anyone lock a known email out indefinitely with ten wrong passwords every window —
    // from one machine. Now those attempts only exhaust the attacker's own (account, address)
    // budget; the owner signing in from elsewhere is unaffected. A much higher per-account
    // ceiling across all addresses still bounds distributed guessing.
    const accountKey = createHash('sha256').update(body.email.trim().toLowerCase()).digest('hex');
    const clientKey = createHash('sha256')
      // IPv6 clients are keyed on their /64 (see rateLimitAddressKey).
      .update(rateLimitAddressKey(req.ip))
      .digest('hex')
      .slice(0, 32);
    await this.accountLimiter.consume(
      `rl:auth_account_ip:${accountKey}:${clientKey}`,
      LOGIN_ATTEMPTS_PER_ACCOUNT,
      LOGIN_ACCOUNT_WINDOW_SECONDS,
    );
    await this.accountLimiter.consume(
      `rl:auth_account:${accountKey}`,
      LOGIN_ATTEMPTS_PER_ACCOUNT_ALL_CLIENTS,
      LOGIN_ACCOUNT_WINDOW_SECONDS,
    );
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
    const fromBody = body.refreshToken?.trim();
    const raw = fromBody || readCookie(req, REFRESH_COOKIE);
    if (!raw) {
      clearAuthCookies(res, this.cookieSecure());
      throw new UnauthorizedException('Refresh token required.');
    }
    try {
      const result = await this.authService.refresh(raw, requestContext(req));
      this.writeSessionCookies(res, result.accessToken!, result.refreshToken!);
      return this.shapeAuthResponse(req, result, { credentialFromCookie: !fromBody });
    } catch (error) {
      // A lost rotation race must not wipe the cookies the winning client just set.
      if (!(error instanceof RefreshTokenRotatedException)) {
        clearAuthCookies(res, this.cookieSecure());
      }
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

  private shapeAuthResponse(
    req: Request,
    result: AuthTokenResponse,
    options: { credentialFromCookie?: boolean } = {},
  ): AuthTokenResponse {
    if (wantsBodyTokens(req, options)) {
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

/** Explicit extension signals only (header or chrome-extension:// Origin). */
function isExtensionClient(req: Request): boolean {
  const header = req.headers[EXTENSION_CLIENT_HEADER];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value === 'string' && value.trim().toLowerCase() === 'extension') return true;
  const origin = req.headers.origin;
  return typeof origin === 'string' && origin.startsWith('chrome-extension://');
}

/**
 * F-13: tokens are returned in the JSON body only to clients that cannot use the HttpOnly
 * session cookie (the extension, non-browser clients) — never to a web page:
 *
 * - A request authenticated by the session COOKIE never gets body tokens (the caller is a
 *   browser that already holds the cookie; handing the tokens to its JavaScript would defeat
 *   HttpOnly). The extension always presents its refresh token in the body.
 * - A request with a web `Origin` (http/https — browsers set it on every cross-origin and
 *   every POST request, and page scripts cannot forge it) never gets body tokens, whatever
 *   `X-Project-X-Client` says: that header is caller-supplied and proves nothing.
 * - Extension origins and requests without an Origin (service workers, CLI) do.
 */
export function wantsBodyTokens(
  req: Pick<Request, 'headers'>,
  options: { credentialFromCookie?: boolean } = {},
): boolean {
  if (options.credentialFromCookie) {
    return false;
  }
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin.length > 0) {
    return /^(?:chrome|moz)-extension:\/\//.test(origin);
  }
  return true;
}

function requestContext(req: Request): { userAgent?: string; ip?: string } {
  return {
    userAgent:
      typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined,
    ip: req.ip,
  };
}
