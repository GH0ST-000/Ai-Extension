import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ usePathname: () => '/app' }));
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: unknown }) => (
    <a href={href} {...rest}>
      {children as never}
    </a>
  ),
}));
vi.mock('./nav-pending-indicator', () => ({ NavPendingIndicator: () => null }));

import { DASHBOARD_NAV_ITEMS, DashboardNav } from './dashboard-nav';
import { DashboardMobileNav } from './dashboard-mobile-nav';

afterEach(() => cleanup());

describe('dashboard navigation (beta)', () => {
  it('does not list Reliability; Review history stays', () => {
    expect(DASHBOARD_NAV_ITEMS.map((item) => item.href)).not.toContain('/app/reliability');
    render(<DashboardNav />);
    const nav = screen.getByRole('navigation', { name: 'Dashboard' });
    expect(within(nav).queryByText('Reliability')).toBeNull();
    expect(within(nav).getByText('Review history').closest('a')?.getAttribute('href')).toBe(
      '/app/reviews',
    );
  });

  it('the mobile "More" menu does not list Reliability either', () => {
    render(<DashboardMobileNav />);
    fireEvent.click(screen.getByRole('button', { name: /More/ }));
    const menu = screen.getByRole('menu', { name: 'More destinations' });
    expect(within(menu).queryByText('Reliability')).toBeNull();
    expect(within(menu).getByText('Review history')).toBeTruthy();
  });
});
