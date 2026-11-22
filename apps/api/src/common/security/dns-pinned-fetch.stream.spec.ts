/**
 * F-11: the response size cap is enforced while streaming, against a real local HTTP server
 * (no mocks of node:http). `pinRecords` is supplied so the loopback test server is reachable;
 * production callers always resolve through resolvePublicHostAddresses first.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ResponseTooLargeError, dnsPinnedFetch } from './dns-pinned-fetch';

const CHUNK = Buffer.alloc(64 * 1024, 0x61);
const LOOPBACK = [{ address: '127.0.0.1', family: 4 }];

describe('dnsPinnedFetch — streaming size cap (F-11)', () => {
  let server: Server;
  let base: string;
  let bytesWritten = 0;
  let seenHost: string | undefined;

  beforeAll(async () => {
    server = createServer((req, res) => {
      seenHost = req.headers.host;
      if (req.url === '/small') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }
      if (req.url === '/declared') {
        res.writeHead(200, { 'content-length': String(50 * 1024 * 1024) });
        res.flushHeaders();
        return; // never sends the body
      }
      // Endless chunked stream (no Content-Length): only stops when the client hangs up.
      res.writeHead(200, { 'content-type': 'text/plain' });
      bytesWritten = 0;
      const pump = () => {
        while (!res.destroyed) {
          bytesWritten += CHUNK.length;
          if (!res.write(CHUNK)) {
            res.once('drain', pump);
            return;
          }
        }
      };
      res.on('error', () => undefined);
      pump();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns a body under the cap and keeps the port in the Host header', async () => {
    const res = await dnsPinnedFetch(new URL(`${base}/small`), {
      pinRecords: LOOPBACK,
      maxResponseBytes: 1024,
    });
    expect(await res.text()).toBe('{"ok":true}');
    expect(seenHost).toBe(new URL(base).host);
  });

  it('aborts an endless stream as soon as the cap is passed (does not buffer it)', async () => {
    const cap = 256 * 1024;
    await expect(
      dnsPinnedFetch(new URL(`${base}/endless`), { pinRecords: LOOPBACK, maxResponseBytes: cap }),
    ).rejects.toBeInstanceOf(ResponseTooLargeError);
    // The server was cut off shortly after the cap, far below "as much as it can send".
    await new Promise((resolve) => setTimeout(resolve, 50));
    const settled = bytesWritten;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(bytesWritten).toBe(settled);
    expect(settled).toBeLessThan(cap + 16 * 1024 * 1024);
  });

  it('refuses a declared Content-Length above the cap before reading the body', async () => {
    await expect(
      dnsPinnedFetch(new URL(`${base}/declared`), { pinRecords: LOOPBACK, maxResponseBytes: 1024 }),
    ).rejects.toBeInstanceOf(ResponseTooLargeError);
  });
});
