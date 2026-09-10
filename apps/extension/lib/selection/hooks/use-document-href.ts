import { useEffect, useState } from 'react';

/**
 * Track document URL for SPA navigations (Jira / GitHub client-side routing).
 * Polls lightly + listens for popstate. Does not scrape page content.
 */
export function useDocumentHref(pollMs = 400): string {
  const [href, setHref] = useState(() =>
    typeof window === 'undefined' ? '' : window.location.href,
  );

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const sync = () => {
      const next = window.location.href;
      setHref((prev) => (prev === next ? prev : next));
    };

    sync();
    window.addEventListener('popstate', sync);
    const id = window.setInterval(sync, pollMs);
    return () => {
      window.removeEventListener('popstate', sync);
      window.clearInterval(id);
    };
  }, [pollMs]);

  return href;
}
