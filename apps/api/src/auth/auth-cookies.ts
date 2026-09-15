import type { CookieOptions, Request, Response } from 'express';

export const ACCESS_COOKIE = 'px_at';
export const REFRESH_COOKIE = 'px_rt';

/** Parse durations like 15m / 7d / 12h into milliseconds. */
export function durationToMs(spec: string, fallbackMs: number): number {
  const match = /^(\d+)\s*([smhd])$/i.exec(spec.trim());
  if (!match) {
    return fallbackMs;
  }
  const amount = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  const factor =
    unit === 's' ? 1_000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return amount * factor;
}

export function durationToSeconds(spec: string, fallbackSeconds: number): number {
  return Math.max(1, Math.floor(durationToMs(spec, fallbackSeconds * 1000) / 1000));
}

function baseCookieOptions(secure: boolean, maxAgeMs: number): CookieOptions {
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeMs,
  };
}

export function setAuthCookies(
  res: Response,
  tokens: { accessToken: string; refreshToken: string },
  options: { secure: boolean; accessMaxAgeMs: number; refreshMaxAgeMs: number },
): void {
  res.cookie(
    ACCESS_COOKIE,
    tokens.accessToken,
    baseCookieOptions(options.secure, options.accessMaxAgeMs),
  );
  res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
    ...baseCookieOptions(options.secure, options.refreshMaxAgeMs),
    // Limit refresh cookie to auth routes when possible; path '/' keeps refresh
    // usable from credentialed SPA calls that hit /api/auth/refresh.
    path: '/api/auth',
  });
}

export function clearAuthCookies(res: Response, secure: boolean): void {
  const cleared: CookieOptions = {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  };
  res.cookie(ACCESS_COOKIE, '', cleared);
  res.cookie(REFRESH_COOKIE, '', { ...cleared, path: '/api/auth' });
  // Also clear legacy path variants if an older build set refresh on '/'.
  res.cookie(REFRESH_COOKIE, '', cleared);
}

export function readCookie(req: Request, name: string): string | null {
  const cookies = (req as Request & { cookies?: Record<string, string> }).cookies;
  const value = cookies?.[name];
  return typeof value === 'string' && value.length > 0 ? value : null;
}
