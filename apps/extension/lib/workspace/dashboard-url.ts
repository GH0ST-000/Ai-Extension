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

export function getDashboardBillingUrl(workspaceId?: string | null): string {
  return getDashboardAppUrl('/app/billing', workspaceId);
}
