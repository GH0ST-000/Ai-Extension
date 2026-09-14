import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { DashboardAppShell } from '../../components/dashboard-app-shell';
import { NO_INDEX_ROBOTS } from '../../lib/site';

export const metadata: Metadata = {
  title: 'Studio',
  robots: NO_INDEX_ROBOTS,
};

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return <DashboardAppShell>{children}</DashboardAppShell>;
}
