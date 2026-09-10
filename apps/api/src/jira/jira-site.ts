/**
 * Jira Cloud host / issue-key safety helpers.
 * Prevents SSRF by allowing only *.atlassian.net HTTPS hosts.
 */

const ATLASSIAN_HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?\.atlassian\.net$/i;
const ISSUE_KEY = /^[A-Z][A-Z0-9]+-\d+$/i;

export function normalizeJiraSiteHost(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }

  let host = trimmed;
  try {
    if (trimmed.includes('://')) {
      const url = new URL(trimmed);
      if (url.protocol !== 'https:') {
        return null;
      }
      host = url.hostname.toLowerCase();
    } else {
      host = trimmed.replace(/\/+$/, '').split('/')[0] ?? '';
    }
  } catch {
    return null;
  }

  if (!ATLASSIAN_HOST.test(host)) {
    return null;
  }
  return host;
}

export function jiraSiteBaseUrl(siteHost: string): string {
  return `https://${siteHost}`;
}

export function normalizeJiraIssueKey(raw: string): string | null {
  const trimmed = raw.trim().toUpperCase();
  if (!ISSUE_KEY.test(trimmed)) {
    return null;
  }
  return trimmed;
}

/** Boundary-aware Jira key matcher — rejects bare numbers like "321". */
export function findJiraIssueKeysInText(text: string): string[] {
  if (!text) {
    return [];
  }
  const matches = text.match(/\b[A-Z][A-Z0-9]+-\d+\b/gi) ?? [];
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const match of matches) {
    const key = match.toUpperCase();
    if (!seen.has(key) && ISSUE_KEY.test(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}
