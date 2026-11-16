/** Same rules as registration. */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

/**
 * Reads the token from the link's fragment (`#token=…`) and removes it from the address bar
 * at once, so it stays out of history, Referer headers and any telemetry. It is kept only in
 * memory — never in storage.
 */
export function readResetTokenFromHash(hash: string): string | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const token = params.get('token');
  return token && /^[A-Za-z0-9_-]{20,200}$/.test(token) ? token : null;
}

export function passwordProblem(password: string, confirmation: string): string | null {
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  if (password !== confirmation) return 'The passwords do not match.';
  return null;
}
