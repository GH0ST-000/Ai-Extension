'use client';

import { useEffect, useState } from 'react';

import { REGISTER_HREF } from '../app/login/auth-mode';
import { attributionFromSearch, referrerHostOf, withAttribution } from '../lib/attribution';

/**
 * Registration link that carries this visit's allowlisted campaign parameters (and the
 * external referrer host) to the sign-up form. Plain `/login?mode=register` without them.
 */
export function useRegisterHref(): string {
  const [href, setHref] = useState(REGISTER_HREF);
  useEffect(() => {
    const attribution = attributionFromSearch(
      window.location.search,
      referrerHostOf(document.referrer, window.location.hostname),
    );
    setHref(withAttribution(REGISTER_HREF, attribution));
  }, []);
  return href;
}
