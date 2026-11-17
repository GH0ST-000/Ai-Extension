/** Dashboard origin for upgrade / billing CTAs — never embed Paddle checkout here. */
export function getDashboardBaseUrl(): string {
  const configured = process.env.PLASMO_PUBLIC_DASHBOARD_URL?.trim();
  return (configured && configured.length > 0 ? configured : 'http://localhost:3000').replace(
    /\/$/,
    '',
  );
}

/** Build a dashboard path URL, optionally pinning the active workspace. */
export function getDashboardAppUrl(path = '/app', workspaceId?: string | null): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(`${getDashboardBaseUrl()}${normalized}`);
  const trimmed = workspaceId?.trim();
  if (trimmed) {
    url.searchParams.set('workspace', trimmed);
  }
  return url.toString();
}

/** Password reset lives on the dashboard; the extension only links to it. */
export function getDashboardForgotPasswordUrl(): string {
  return getDashboardAppUrl('/forgot-password');
}

export function getDashboardBillingUrl(workspaceId?: string | null): string {
  return getDashboardAppUrl('/app/billing', workspaceId);
}

/**
 * The dashboard's optional "three quick questions" page. Carries no credentials: the dashboard
 * uses its own session (shared API cookies when present, otherwise the normal sign-in page).
 */
export function getDashboardWelcomeUrl(): string {
  const url = new URL(getDashboardAppUrl('/app/welcome'));
  url.searchParams.set('next', '/app');
  return url.toString();
}
