import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';

import { isPrivateOrReservedIp } from '@project-x/shared';

export type DnsPinErrorCode = 'DNS' | 'PRIVATE_IP';

export class DnsPinError extends Error {
  constructor(readonly code: DnsPinErrorCode) {
    super(code);
    this.name = 'DnsPinError';
  }
}

/** Resolve hostname and ensure every answer is a public IP (SSRF / rebinding guard). */
export async function resolvePublicHostAddresses(
  hostname: string,
): Promise<Array<{ address: string; family: number }>> {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  const hostForIp = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;

  if (isIP(hostForIp)) {
    if (isPrivateOrReservedIp(hostForIp)) {
      throw new DnsPinError('PRIVATE_IP');
    }
    return [{ address: hostForIp, family: isIP(hostForIp) === 6 ? 6 : 4 }];
  }

  let records: LookupAddress[];
  try {
    records = (await lookup(host, { all: true, verbatim: true })) as LookupAddress[];
  } catch {
    throw new DnsPinError('DNS');
  }
  if (!records.length) {
    throw new DnsPinError('DNS');
  }

  for (const record of records) {
    if (isPrivateOrReservedIp(record.address)) {
      throw new DnsPinError('PRIVATE_IP');
    }
  }

  return records.map((record) => ({ address: record.address, family: record.family }));
}

function pickPinTarget(records: Array<{ address: string; family: number }>): {
  address: string;
  family: number;
} {
  const ipv4 = records.find((r) => r.family === 4);
  return ipv4 ?? records[0]!;
}

function headersToFetchHeaders(headers: IncomingHttpHeaders): Headers {
  const out = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) out.append(key, v);
    } else {
      out.set(key, value);
    }
  }
  return out;
}

/**
 * GET (or other methods) over HTTP(S) connecting to a pre-resolved public IP while preserving
 * the original Host header and TLS SNI — mitigates DNS rebinding between validation and connect.
 */
export async function dnsPinnedFetch(
  url: URL,
  init: RequestInit & { pinRecords?: Array<{ address: string; family: number }> } = {},
): Promise<Response> {
  const records = init.pinRecords ?? (await resolvePublicHostAddresses(url.hostname));
  const pin = pickPinTarget(records);
  const isHttps = url.protocol === 'https:';
  const port = url.port ? Number(url.port) : isHttps ? 443 : 80;
  const path = `${url.pathname}${url.search}`;

  const headerInit = init.headers;
  const headers: Record<string, string> = {};
  if (headerInit instanceof Headers) {
    headerInit.forEach((value, key) => {
      headers[key] = value;
    });
  } else if (Array.isArray(headerInit)) {
    for (const entry of headerInit) {
      const [key, value] = entry;
      if (key) {
        headers[key] = value ?? '';
      }
    }
  } else if (headerInit) {
    Object.assign(headers, headerInit);
  }
  headers.Host = url.hostname;

  const method = init.method ?? 'GET';
  const body =
    init.body === undefined || init.body === null
      ? undefined
      : typeof init.body === 'string'
        ? init.body
        : Buffer.isBuffer(init.body)
          ? init.body
          : undefined;

  const requestFn = isHttps ? httpsRequest : httpRequest;

  return await new Promise<Response>((resolve, reject) => {
    const req = requestFn(
      {
        host: pin.address,
        port,
        path,
        method,
        headers,
        servername: isHttps ? url.hostname : undefined,
        family: pin.family === 6 ? 6 : 4,
        signal: init.signal ?? undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          resolve(
            new Response(buffer, {
              status: res.statusCode ?? 0,
              headers: headersToFetchHeaders(res.headers),
            }),
          );
        });
      },
    );

    req.on('error', (err) => reject(err));
    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}
