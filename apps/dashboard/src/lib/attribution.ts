import type { SignupAttribution } from '@project-x/types';

/**
 * First-touch attribution, first-party and storage-free: the landing page copies a few
 * allowlisted campaign parameters into the "Get Started" link; the sign-up form sends them
 * with the registration; the server validates them again and stores them once. No cookies,
 * no localStorage, no third-party scripts, no persistent identifier.
 */

/** URL parameter ↔ attribution field. Nothing else is ever read. */
export const ATTRIBUTION_PARAMS = {
  utm_source: 'utmSource',
  utm_medium: 'utmMedium',
  utm_campaign: 'utmCampaign',
  utm_content: 'utmContent',
  ref: 'referral',
  ref_host: 'referrerHost',
} as const satisfies Record<string, keyof SignupAttribution>;

const MAX_LENGTH = 100;
const VALUE_CHARSET = /^[A-Za-z0-9 ._-]+$/;

function cleanValue(raw: string | null): string | null {
  const value = raw?.trim() ?? '';
  return value && value.length <= MAX_LENGTH && VALUE_CHARSET.test(value) ? value : null;
}

/** External referrer host only (never a path or query); own-site referrers are ignored. */
export function referrerHostOf(referrer: string, ownHost: string): string | null {
  if (!referrer) return null;
  try {
    const url = new URL(referrer);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const host = url.hostname.toLowerCase();
    return host && host !== ownHost.toLowerCase() ? host.slice(0, 253) : null;
  } catch {
    return null;
  }
}

/** Allowlisted attribution parameters from a URL query (plus an optional referrer host). */
export function attributionFromSearch(
  search: string | URLSearchParams,
  referrerHost: string | null = null,
): URLSearchParams {
  const input = typeof search === 'string' ? new URLSearchParams(search) : search;
  const out = new URLSearchParams();
  for (const key of Object.keys(ATTRIBUTION_PARAMS)) {
    const value = key === 'ref_host' ? null : cleanValue(input.get(key));
    if (value) out.set(key, value);
  }
  const host =
    cleanValue(input.get('ref_host')) ?? (referrerHost ? cleanValue(referrerHost) : null);
  if (host) out.set('ref_host', host);
  return out;
}

/** The registration payload field built from the sign-up page URL. */
export function signupAttributionFrom(search: URLSearchParams): SignupAttribution | undefined {
  const params = attributionFromSearch(search);
  const result: SignupAttribution = {};
  for (const [param, field] of Object.entries(ATTRIBUTION_PARAMS)) {
    const value = params.get(param);
    if (value) result[field] = value;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Append attribution parameters to an internal link (e.g. the register CTA). */
export function withAttribution(href: string, attribution: URLSearchParams): string {
  if ([...attribution.keys()].length === 0) return href;
  const [path, query = ''] = href.split('?');
  const params = new URLSearchParams(query);
  attribution.forEach((value, key) => {
    if (!params.has(key)) params.set(key, value);
  });
  return `${path}?${params.toString()}`;
}
