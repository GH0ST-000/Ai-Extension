'use client';

import { useLinkStatus } from 'next/link';

/** Inline pending hint for a Next.js Link — delays briefly to avoid flash on fast nav. */
export function NavPendingIndicator() {
  const { pending } = useLinkStatus();

  return (
    <span
      aria-hidden
      className={[
        'inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent',
        'transition-opacity duration-150',
        // Fade in only after a short delay so fast navigations don't flash the dot.
        pending ? 'nav-pending-dot opacity-100 delay-150' : 'opacity-0',
      ].join(' ')}
    />
  );
}
