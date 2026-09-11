/**
 * SSRF-safe URL validation for Day 18 OpenAPI document fetch.
 * Browser-safe: no Node DNS or net builtins — DNS resolution stays in apps/api OpenApiFetchService.
 * Blocks private/loopback/link-local/metadata hosts and non-http(s) schemes.
 */

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.google',
  'instance-data',
]);

export type SafeUrlRejectReason =
  'invalid' | 'scheme' | 'credentials' | 'hostname' | 'private-ip' | 'blocked-host';

export type SafeUrlResult =
  { ok: true; url: URL; sanitizedHref: string } | { ok: false; reason: SafeUrlRejectReason };

/** Pure-JS IPv4 detection (replaces Node net isIP === 4). */
export function isIPv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) {
    return false;
  }
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return false;
    }
    const n = Number(part);
    if (n > 255 || String(n) !== part) {
      return false;
    }
  }
  return true;
}

/**
 * Lightweight IPv6 detection for hostname literals (replaces Node net isIP === 6).
 * Accepts compressed forms and IPv4-mapped addresses (::ffff:a.b.c.d).
 */
export function isIPv6(ip: string): boolean {
  let v = ip.toLowerCase().split('%')[0]!;
  if (v.startsWith('[') && v.endsWith(']')) {
    v = v.slice(1, -1);
  }
  if (!v.includes(':') || /[^0-9a-f:.]/.test(v)) {
    return false;
  }

  if (v.includes('.')) {
    const lastColon = v.lastIndexOf(':');
    if (lastColon < 0) {
      return false;
    }
    const mapped = v.slice(lastColon + 1);
    if (!isIPv4(mapped)) {
      return false;
    }
    const head = v.slice(0, lastColon);
    if (!head || /[^0-9a-f:]/.test(head)) {
      return false;
    }
    const parts = head.split('::');
    if (parts.length > 2) {
      return false;
    }
    for (const side of parts) {
      if (!side) continue;
      for (const g of side.split(':')) {
        if (g && !/^[0-9a-f]{1,4}$/.test(g)) {
          return false;
        }
      }
    }
    return true;
  }

  return isIPv6HexBody(v);
}

function isIPv6HexBody(value: string): boolean {
  if (value === '::') {
    return true;
  }
  // At most one '::'
  const compressed = value.split('::');
  if (compressed.length > 2) {
    return false;
  }
  const sides = compressed.length === 2 ? compressed : [value];
  let groupCount = 0;
  for (const side of sides) {
    if (!side) {
      continue;
    }
    const groups = side.split(':');
    for (const g of groups) {
      if (!/^[0-9a-f]{1,4}$/i.test(g)) {
        return false;
      }
      groupCount += 1;
    }
  }
  if (compressed.length === 2) {
    return groupCount < 8;
  }
  return groupCount === 8;
}

function ipVersion(ip: string): 0 | 4 | 6 {
  if (isIPv4(ip)) {
    return 4;
  }
  if (isIPv6(ip)) {
    return 6;
  }
  return 0;
}

export function isPrivateOrReservedIp(ip: string): boolean {
  const bare = ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip;
  const v = ipVersion(bare);
  if (v === 4) {
    const parts = bare.split('.').map((p) => Number(p));
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
      return true;
    }
    const a = parts[0]!;
    const b = parts[1]!;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  if (v === 6) {
    const normalized = bare.toLowerCase().split('%')[0]!;
    if (normalized === '::1' || normalized === '::') return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // ULA
    if (normalized.startsWith('fe80')) return true; // link-local
    if (normalized.startsWith('ff')) return true; // multicast
    // IPv4-mapped
    if (normalized.includes('.')) {
      const mapped = normalized.split(':').pop();
      if (mapped && isIPv4(mapped)) {
        return isPrivateOrReservedIp(mapped);
      }
    }
    return false;
  }
  return true;
}

/** Strip userinfo / sensitive query tokens from display URLs. */
export function sanitizeOpenApiDocumentUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = '';
    url.password = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/(token|key|secret|password|auth|sig|signature|access)/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    return url.toString();
  } catch {
    return raw.split('?')[0] ?? raw;
  }
}

export function validateOpenApiFetchUrl(
  raw: string,
  options?: { allowHttp?: boolean },
): SafeUrlResult {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, reason: 'invalid' };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'invalid' };
  }

  if (url.protocol === 'https:') {
    // ok
  } else if (url.protocol === 'http:' && options?.allowHttp) {
    // ok for explicit local-dev opt-in only — Day 18 default is https
  } else if (
    url.protocol === 'file:' ||
    url.protocol === 'ftp:' ||
    url.protocol === 'data:' ||
    url.protocol === 'javascript:'
  ) {
    return { ok: false, reason: 'scheme' };
  } else {
    return { ok: false, reason: 'scheme' };
  }

  // Day 18 production path: prefer https only
  if (url.protocol !== 'https:') {
    return { ok: false, reason: 'scheme' };
  }

  if (url.username || url.password) {
    return { ok: false, reason: 'credentials' };
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  // Some runtimes keep brackets on IPv6 URL.hostname (e.g. "[::1]").
  const hostForIp = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (
    !host ||
    BLOCKED_HOSTNAMES.has(host) ||
    host.endsWith('.localhost') ||
    host.endsWith('.local')
  ) {
    return { ok: false, reason: 'blocked-host' };
  }

  if (
    host === 'metadata.google.internal' ||
    host.startsWith('169.254.') ||
    hostForIp.startsWith('169.254.')
  ) {
    return { ok: false, reason: 'blocked-host' };
  }

  if (ipVersion(hostForIp) !== 0) {
    if (isPrivateOrReservedIp(hostForIp)) {
      return { ok: false, reason: 'private-ip' };
    }
  }

  return {
    ok: true,
    url,
    sanitizedHref: sanitizeOpenApiDocumentUrl(url.toString()),
  };
}
