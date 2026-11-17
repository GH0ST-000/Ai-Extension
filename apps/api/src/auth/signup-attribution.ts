import { ATTRIBUTION_MAX_LENGTH, type SignupAttribution } from '@project-x/types';

/** Slug-like campaign values: letters, digits, space, dot, dash, underscore. */
const VALUE_CHARSET = /^[A-Za-z0-9 ._-]+$/;
/** Well-known credential prefixes (GitHub, Slack, Stripe, AWS, GitLab, npm, JWT header). */
const SECRET_PREFIXES = [
  'ghp_',
  'gho_',
  'ghu_',
  'ghs_',
  'ghr_',
  'github_pat_',
  'glpat-',
  'npm_',
  'xox',
  'sk-',
  'sk_',
  'pk_live',
  'rk_live',
  'akia',
  'asia',
  'eyj',
];
/** Prefix checks only apply to values long enough to be a credential. */
const SECRET_MIN_LENGTH = 20;
/** Long digit runs: card numbers, phone numbers, internal ids. */
const MAX_DIGIT_RUN = 12;
/** Random strings switch between lower / upper / digit far more often than words do. */
const RANDOM_MIN_LENGTH = 20;
const RANDOM_SWITCH_RATIO = 0.3;

function charClass(code: number): 0 | 1 | 2 | 3 {
  if (code >= 48 && code <= 57) return 1; // digit
  if (code >= 65 && code <= 90) return 2; // upper
  if (code >= 97 && code <= 122) return 3; // lower
  return 0; // separator
}

/**
 * Credential / identifier heuristics. Ordinary campaign names — including long words such as
 * "internationalization" — pass; tokens, keys, JWTs and long numbers do not. Linear time.
 */
export function looksSecretLike(value: string): boolean {
  const lower = value.toLowerCase();
  if (value.length >= SECRET_MIN_LENGTH && SECRET_PREFIXES.some((p) => lower.startsWith(p))) {
    return true;
  }
  let digitRun = 0;
  let alnum = 0;
  let switches = 0;
  let previous = 0;
  for (let i = 0; i < value.length; i += 1) {
    const cls = charClass(value.charCodeAt(i));
    digitRun = cls === 1 ? digitRun + 1 : 0;
    if (digitRun >= MAX_DIGIT_RUN) return true;
    if (cls === 0) continue; // separators do not break a random-looking string
    if (previous !== 0 && cls !== previous) switches += 1;
    previous = cls;
    alnum += 1;
  }
  return alnum >= RANDOM_MIN_LENGTH && switches / (alnum - 1) >= RANDOM_SWITCH_RATIO;
}

/**
 * One untrusted attribution value → a safe value or null (dropped, never an error).
 * The slug alphabet already excludes emails, URLs and query strings (no `@ / : = ? & %`);
 * credential-looking values are refused on top.
 */
export function sanitizeAttributionValue(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > ATTRIBUTION_MAX_LENGTH) return null;
  if (!VALUE_CHARSET.test(value)) return null;
  if (looksSecretLike(value)) return null;
  return value;
}

/** A hostname only (no scheme, port, path, query or credentials), lower-cased. */
export function sanitizeReferrerHost(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const host = raw.trim().toLowerCase();
  if (host.length === 0 || host.length > 253) return null;
  const labels = host.split('.');
  if (labels.length < 2) return null;
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) return null;
    if (label.startsWith('-') || label.endsWith('-')) return null;
    for (const char of label) {
      const code = char.charCodeAt(0);
      const ok = (code >= 48 && code <= 57) || (code >= 97 && code <= 122) || char === '-';
      if (!ok) return null;
    }
  }
  return host;
}

/** Sanitized first-touch attribution; unknown keys are ignored entirely. */
export function sanitizeSignupAttribution(raw: unknown): Required<{
  [K in keyof SignupAttribution]: string | null;
}> {
  const input =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    utmSource: sanitizeAttributionValue(input.utmSource),
    utmMedium: sanitizeAttributionValue(input.utmMedium),
    utmCampaign: sanitizeAttributionValue(input.utmCampaign),
    utmContent: sanitizeAttributionValue(input.utmContent),
    referral: sanitizeAttributionValue(input.referral),
    referrerHost: sanitizeReferrerHost(input.referrerHost),
  };
}
