import type { Metadata } from 'next';
import type { ReactNode } from 'react';

/** Account-recovery pages: never indexed, never send a Referer (see next.config headers). */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

export default function AccountRecoveryLayout({ children }: { children: ReactNode }) {
  return children;
}
