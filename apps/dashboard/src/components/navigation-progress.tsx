'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

/**
 * Thin top progress bar shown as soon as an in-app link is clicked,
 * until the route pathname updates. Avoids the "frozen" feel between menu taps.
 */
export function NavigationProgress() {
  const pathname = usePathname();
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setPending(false);
  }, [pathname]);

  useEffect(() => {
    function onClick(event: MouseEvent) {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }
      const anchor = (event.target as Element | null)?.closest?.('a');
      if (!anchor || !(anchor instanceof HTMLAnchorElement)) {
        return;
      }
      if (anchor.target && anchor.target !== '_self') {
        return;
      }
      if (anchor.hasAttribute('download')) {
        return;
      }

      const href = anchor.getAttribute('href');
      if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) {
        return;
      }

      let url: URL;
      try {
        url = new URL(href, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) {
        return;
      }
      // The bar is cleared by a pathname change, so query-only navigations
      // (e.g. ?tab=x) must not start it or it would hang until the safety timeout.
      if (url.pathname === window.location.pathname) {
        return;
      }

      setPending(true);
    }

    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  // Safety: never leave the bar stuck if navigation is cancelled.
  useEffect(() => {
    if (!pending) {
      return;
    }
    const timer = window.setTimeout(() => setPending(false), 8_000);
    return () => window.clearTimeout(timer);
  }, [pending]);

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-[60] h-0.5 overflow-hidden"
      aria-hidden={!pending}
    >
      <div
        className={[
          'h-full origin-left bg-accent transition-opacity duration-150',
          pending ? 'opacity-100 nav-progress-bar' : 'opacity-0',
        ].join(' ')}
      />
    </div>
  );
}
