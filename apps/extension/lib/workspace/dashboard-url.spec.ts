import { describe, expect, it } from 'vitest';

import { getDashboardBaseUrl, getDashboardForgotPasswordUrl } from './dashboard-url';

describe('dashboard URLs', () => {
  it('forgot password links to the dashboard recovery page (no workspace, no token)', () => {
    const url = new URL(getDashboardForgotPasswordUrl());
    expect(`${url.origin}`).toBe(new URL(getDashboardBaseUrl()).origin);
    expect(url.pathname).toBe('/forgot-password');
    expect(url.search).toBe('');
    expect(url.hash).toBe('');
  });
});
