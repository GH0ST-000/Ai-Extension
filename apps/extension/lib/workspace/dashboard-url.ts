/** Dashboard origin for upgrade / billing CTAs — never embed Paddle checkout here. */
export function getDashboardBaseUrl(): string {
  const configured = process.env.PLASMO_PUBLIC_DASHBOARD_URL?.trim();
  return (configured && configured.length > 0 ? configured : 'http://localhost:3000').replace(
    /\/$/,
    '',
  );
}

export function getDashboardBillingUrl(): string {
  return `${getDashboardBaseUrl()}/app/billing`;
}
