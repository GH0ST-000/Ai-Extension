'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export const DASHBOARD_NAV_ITEMS = [
  { href: '/app', label: 'Overview', hint: 'Workspace pulse' },
  { href: '/app/memory', label: 'Memory', hint: 'Project context' },
  { href: '/app/systems', label: 'Systems', hint: 'Multi-repo scope' },
  { href: '/app/reliability', label: 'Reliability', hint: 'Audit & recovery' },
  { href: '/app/workspace', label: 'Workspace', hint: 'General settings' },
  { href: '/app/workspace/members', label: 'Members', hint: 'Roles & invites' },
  { href: '/app/billing', label: 'Billing', hint: 'Plan & usage' },
  { href: '/app/settings', label: 'Settings', hint: 'Preferences' },
] as const;

export function isDashboardNavActive(pathname: string, href: string): boolean {
  if (href === '/app') {
    return pathname === '/app';
  }
  if (href === '/app/workspace') {
    return pathname === '/app/workspace';
  }
  return pathname.startsWith(href);
}

export function DashboardNav() {
  const pathname = usePathname() ?? '';

  return (
    <nav className="space-y-1" aria-label="Dashboard">
      {DASHBOARD_NAV_ITEMS.map((item) => {
        const active = isDashboardNavActive(pathname, item.href);

        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={[
              'group flex flex-col rounded-xl px-3 py-2.5 transition-colors duration-200',
              active
                ? 'bg-accent-soft text-ink'
                : 'text-muted-foreground hover:bg-panel/70 hover:text-ink',
            ].join(' ')}
          >
            <span className="flex items-center gap-2 text-sm font-semibold tracking-tight">
              <span
                className={[
                  'h-1.5 w-1.5 rounded-full transition-colors',
                  active ? 'bg-accent' : 'bg-line group-hover:bg-accent/60',
                ].join(' ')}
              />
              {item.label}
            </span>
            <span className="pl-3.5 text-[11px] text-muted-foreground/90">{item.hint}</span>
          </Link>
        );
      })}
    </nav>
  );
}
