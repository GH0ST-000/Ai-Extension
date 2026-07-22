import type { ReactNode } from 'react';
import Link from 'next/link';

import { APP_NAME } from '@project-x/shared';

const navItems = [
  { href: '/app', label: 'Overview' },
  { href: '/app/settings', label: 'Settings' },
] as const;

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="mx-auto flex min-h-screen max-w-7xl">
        <aside className="hidden w-64 shrink-0 border-r border-slate-200 bg-white p-6 md:block">
          <div className="mb-8">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
              {APP_NAME}
            </p>
            <h1 className="mt-2 text-lg font-semibold">Dashboard</h1>
          </div>
          <nav className="space-y-1">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="block rounded-md px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 items-center justify-between border-b border-slate-200 bg-white px-6">
            <p className="text-sm font-medium text-slate-700">Workspace</p>
            <Link href="/login" className="text-sm text-slate-500 hover:text-slate-800">
              Login
            </Link>
          </header>
          <main className="flex-1 p-6">{children}</main>
        </div>
      </div>
    </div>
  );
}
