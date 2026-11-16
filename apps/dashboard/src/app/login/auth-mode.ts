export type AuthMode = 'login' | 'register';

/** `/login?mode=register` opens registration; anything else is the normal sign-in form. */
export function authModeFromParam(value: string | null | undefined): AuthMode {
  return value === 'register' ? 'register' : 'login';
}

/**
 * URL for an auth mode, keeping other query parameters (e.g. `next`). Sign-in is the default
 * and has no `mode` parameter.
 */
export function authModeHref(mode: AuthMode, current: URLSearchParams | null): string {
  const params = new URLSearchParams(current?.toString() ?? '');
  if (mode === 'register') params.set('mode', 'register');
  else params.delete('mode');
  const qs = params.toString();
  return qs ? `/login?${qs}` : '/login';
}

/** Landing / marketing CTA for new users. */
export const REGISTER_HREF = '/login?mode=register';
