import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { NO_INDEX_ROBOTS, SITE_NAME } from '../../lib/site';

export const metadata: Metadata = {
  title: 'Sign in',
  description: `Sign in to ${SITE_NAME} to connect the Chrome extension, studio, GitHub, and Jira.`,
  robots: NO_INDEX_ROBOTS,
  alternates: {
    canonical: '/login',
  },
};

export default function LoginLayout({ children }: { children: ReactNode }) {
  return children;
}
