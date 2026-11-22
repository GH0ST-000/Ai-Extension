import type { Metadata } from 'next';
import type { ReactNode } from 'react';

/** The verification token lives only in the URL fragment: never indexed, never a Referer. */
export const metadata: Metadata = {
  title: 'Confirm email',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default function VerifyEmailLayout({ children }: { children: ReactNode }) {
  return children;
}
