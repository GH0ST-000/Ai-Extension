'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';

import { DASHBOARD_NAV_ITEMS, isDashboardNavActive } from './dashboard-nav';

type MobileTab = {
  href: string;
  label: string;
  icon: 'overview' | 'memory' | 'systems' | 'settings' | 'more';
};

const PRIMARY_TABS: readonly MobileTab[] = [
  { href: '/app', label: 'Home', icon: 'overview' },
  { href: '/app/memory', label: 'Memory', icon: 'memory' },
  { href: '/app/systems', label: 'Systems', icon: 'systems' },
  { href: '/app/settings', label: 'Settings', icon: 'settings' },
] as const;

const MORE_HREFS = new Set([
  '/app/reliability',
  '/app/workspace',
  '/app/workspace/members',
  '/app/billing',
]);

function TabIcon({ name, active }: { name: MobileTab['icon']; active: boolean }) {
  const common = {
    width: 22,
    height: 22,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: active ? 2 : 1.75,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true as const,
  };

  switch (name) {
    case 'overview':
      return (
        <svg {...common}>
          <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
          <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
          <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
          <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
        </svg>
      );
    case 'memory':
      return (
        <svg {...common}>
          <path d="M12 3.5v17" />
          <path d="M6.5 8.5h11" />
          <path d="M5 12.5c0-2.5 1.8-4.5 4-5.2C10.2 6.8 11 6.5 12 6.5s1.8.3 3 .8c2.2.7 4 2.7 4 5.2v3.5c0 1.4-1.1 2.5-2.5 2.5h-9C6.1 18.5 5 17.4 5 16z" />
        </svg>
      );
    case 'systems':
      return (
        <svg {...common}>
          <circle cx="6.5" cy="7" r="2.25" />
          <circle cx="17.5" cy="7" r="2.25" />
          <circle cx="12" cy="17" r="2.25" />
          <path d="M8.5 8.2 10.8 15" />
          <path d="M15.5 8.2 13.2 15" />
        </svg>
      );
    case 'settings':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3" />
          <path d="M12 3.5v2.2M12 18.3v2.2M4.9 7.1l1.6 1.6M17.5 15.3l1.6 1.6M3.5 12h2.2M18.3 12h2.2M4.9 16.9l1.6-1.6M17.5 8.7l1.6-1.6" />
        </svg>
      );
    case 'more':
      return (
        <svg {...common}>
          <circle cx="6.5" cy="12" r="1.35" fill="currentColor" stroke="none" />
          <circle cx="12" cy="12" r="1.35" fill="currentColor" stroke="none" />
          <circle cx="17.5" cy="12" r="1.35" fill="currentColor" stroke="none" />
        </svg>
      );
  }
}

export function DashboardMobileNav() {
  const pathname = usePathname() ?? '';
  const [moreOpen, setMoreOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const moreItems = DASHBOARD_NAV_ITEMS.filter((item) => MORE_HREFS.has(item.href));
  const moreActive = moreItems.some((item) => isDashboardNavActive(pathname, item.href));

  useEffect(() => {
    setMoreOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!moreOpen) {
      return;
    }

    function onPointerDown(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) {
        setMoreOpen(false);
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setMoreOpen(false);
      }
    }

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [moreOpen]);

  return (
    <div ref={rootRef} className="pointer-events-none fixed inset-x-0 bottom-0 z-40 md:hidden">
      {moreOpen ? (
        <div
          id={panelId}
          role="menu"
          aria-label="More destinations"
          className="pointer-events-auto mx-3 mb-2 overflow-hidden rounded-2xl border border-line bg-panel shadow-panel"
        >
          <ul className="p-1.5">
            {moreItems.map((item) => {
              const active = isDashboardNavActive(pathname, item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    role="menuitem"
                    aria-current={active ? 'page' : undefined}
                    onClick={() => setMoreOpen(false)}
                    className={[
                      'flex flex-col rounded-xl px-3 py-2.5 transition',
                      active ? 'bg-accent-soft text-ink' : 'text-ink hover:bg-mist',
                    ].join(' ')}
                  >
                    <span className="text-sm font-semibold tracking-tight">{item.label}</span>
                    <span className="text-[11px] text-muted-foreground">{item.hint}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      <nav
        aria-label="Primary"
        className="pointer-events-auto border-t border-line/80 bg-panel/95 px-2 pt-1.5 shadow-panel backdrop-blur-xl"
        style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))' }}
      >
        <ul className="mx-auto flex max-w-lg items-stretch justify-between gap-0.5">
          {PRIMARY_TABS.map((tab) => {
            const active = isDashboardNavActive(pathname, tab.href);
            return (
              <li key={tab.href} className="min-w-0 flex-1">
                <Link
                  href={tab.href}
                  aria-current={active ? 'page' : undefined}
                  className={[
                    'flex flex-col items-center gap-0.5 rounded-xl px-1 py-1.5 text-center transition',
                    active ? 'text-accent' : 'text-muted-foreground hover:text-ink',
                  ].join(' ')}
                >
                  <TabIcon name={tab.icon} active={active} />
                  <span className="max-w-full truncate text-[10px] font-semibold tracking-tight">
                    {tab.label}
                  </span>
                </Link>
              </li>
            );
          })}
          <li className="min-w-0 flex-1">
            <button
              type="button"
              aria-expanded={moreOpen}
              aria-controls={panelId}
              aria-haspopup="menu"
              onClick={() => setMoreOpen((prev) => !prev)}
              className={[
                'flex w-full flex-col items-center gap-0.5 rounded-xl px-1 py-1.5 text-center transition',
                moreActive || moreOpen ? 'text-accent' : 'text-muted-foreground hover:text-ink',
              ].join(' ')}
            >
              <TabIcon name="more" active={moreActive || moreOpen} />
              <span className="max-w-full truncate text-[10px] font-semibold tracking-tight">
                More
              </span>
            </button>
          </li>
        </ul>
      </nav>
    </div>
  );
}
