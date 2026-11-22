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

/**
 * Expand an IPv6 literal (compressed, with or without an embedded dotted IPv4 tail) into its
 * eight 16-bit groups. Returns null when it is not a valid address.
 */
export function expandIPv6(ip: string): number[] | null {
  let v = ip.toLowerCase().split('%')[0]!;
  if (v.startsWith('[') && v.endsWith(']')) {
    v = v.slice(1, -1);
  }
  if (!isIPv6(v)) {
    return null;
  }
  let tail: number[] = [];
  if (v.includes('.')) {
    const lastColon = v.lastIndexOf(':');
    const octets = v
      .slice(lastColon + 1)
      .split('.')
      .map((o) => Number(o));
    tail = [(octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!];
    v = v.slice(0, lastColon);
    // "::1.2.3.4" leaves ":" — restore the compression marker.
    if (v.endsWith(':')) v = `${v}:`;
    if (v === '') return null;
  }
  const parse = (side: string): number[] =>
    side ? side.split(':').map((g) => Number.parseInt(g, 16)) : [];
  const sides = v.split('::');
  if (sides.length > 2) return null;
  const head = parse(sides[0] ?? '');
  const rest = sides.length === 2 ? parse(sides[1] ?? '') : [];
  const fixed = head.length + rest.length + tail.length;
  if (sides.length === 1 ? fixed !== 8 : fixed > 8) return null;
  const groups = [...head, ...new Array<number>(8 - fixed).fill(0), ...rest, ...tail];
  if (groups.length !== 8 || groups.some((g) => !Number.isInteger(g) || g < 0 || g > 0xffff)) {
    return null;
  }
  return groups;
}

function embeddedIPv4(high: number, low: number): string {
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

/**
 * F-33: classify by address bits, not by string prefix — the URL parser serializes
 * `[::ffff:127.0.0.1]` as `[::ffff:7f00:1]`, which has no dot and no `fc`/`fe80` prefix.
 * Every form that carries an IPv4 address is judged by that IPv4 address.
 */
function isPrivateOrReservedIPv6(g: number[]): boolean {
  const g0 = g[0]!;
  const leadingZero = (count: number) => g.slice(0, count).every((x) => x === 0);
  // ::/96 — unspecified, loopback, IPv4-compatible.
  if (leadingZero(6)) {
    if (g[6] === 0 && g[7]! <= 1) return true; // :: and ::1
    return isPrivateOrReservedIp(embeddedIPv4(g[6]!, g[7]!));
  }
  // ::ffff:0:0/96 IPv4-mapped, ::ffff:0:0:0/96 IPv4-translated.
  if (leadingZero(5) && g[5] === 0xffff) return isPrivateOrReservedIp(embeddedIPv4(g[6]!, g[7]!));
  if (leadingZero(4) && g[4] === 0xffff && g[5] === 0) {
    return isPrivateOrReservedIp(embeddedIPv4(g[6]!, g[7]!));
  }
  // 64:ff9b::/96 NAT64 (well-known prefix); 64:ff9b:1::/48 local-use NAT64.
  if (g0 === 0x64 && g[1] === 0xff9b) {
    if (g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
      return isPrivateOrReservedIp(embeddedIPv4(g[6]!, g[7]!));
    }
    return true;
  }
  // 2002::/16 6to4 embeds the IPv4 address in the next 32 bits.
  if (g0 === 0x2002) return isPrivateOrReservedIp(embeddedIPv4(g[1]!, g[2]!));
  if (g0 === 0x2001 && g[1] === 0) return true; // 2001::/32 Teredo (embeds IPv4 endpoints)
  if (g0 === 0x2001 && g[1] === 0xdb8) return true; // documentation
  if (g0 === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // discard-only
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  return false;
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
    const groups = expandIPv6(bare);
    // Unparseable: fail closed.
    return groups ? isPrivateOrReservedIPv6(groups) : true;
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

  // An ALLOWLIST of schemes: https, or http only with the explicit local-development opt-in.
  // Everything else (file:, ftp:, data:, javascript:, vbscript:, blob:, …) is refused without
  // being enumerated — a denylist would always be missing one.
  const schemeAllowed =
    url.protocol === 'https:' || (url.protocol === 'http:' && options?.allowHttp === true);
  if (!schemeAllowed) {
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

  // Reject dword / hex / octal-like IP hostnames that some parsers accept.
  if (/^\d+$/.test(hostForIp) || /^0x[0-9a-f]+$/i.test(hostForIp) || hostForIp.includes('0x')) {
    return { ok: false, reason: 'hostname' };
  }
  // Incomplete IPv4 forms like 127.1 that some resolvers expand.
  if (/^\d{1,3}(\.\d{1,3}){0,2}$/.test(hostForIp) && !isIPv4(hostForIp)) {
    return { ok: false, reason: 'hostname' };
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
