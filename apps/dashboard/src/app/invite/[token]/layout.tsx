import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { NO_INDEX_ROBOTS } from '../../../lib/site';

export const metadata: Metadata = {
  title: 'Accept invite',
  description: 'Accept a Project X workspace invitation.',
  robots: NO_INDEX_ROBOTS,
  // The invitation token is in this page's path: never send it in a Referer (see also the
  // no-store / no-referrer headers in next.config.ts).
  referrer: 'no-referrer',
};

export default function InviteLayout({ children }: { children: ReactNode }) {
  return children;
}
