import { afterEach, describe, expect, it, vi } from 'vitest';

import { DnsPinError, dnsPinnedFetch, resolvePublicHostAddresses } from './dns-pinned-fetch';

const httpsRequestMock = vi.fn();

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}));

vi.mock('node:https', () => ({
  request: (...args: unknown[]) => httpsRequestMock(...args),
}));

describe('resolvePublicHostAddresses', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('rejects private literal IPs', async () => {
    await expect(resolvePublicHostAddresses('127.0.0.1')).rejects.toMatchObject({
      code: 'PRIVATE_IP',
    });
  });

  it('rejects DNS answers pointing at metadata', async () => {
    const { lookup } = await import('node:dns/promises');
    vi.mocked(lookup).mockResolvedValueOnce([
      { address: '169.254.169.254', family: 4 },
    ] as unknown as Awaited<ReturnType<typeof lookup>>);

    await expect(resolvePublicHostAddresses('evil.example.com')).rejects.toMatchObject({
      code: 'PRIVATE_IP',
    });
  });

  it('returns public addresses for hostnames', async () => {
    const records = await resolvePublicHostAddresses('example.com');
    expect(records).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });
});

describe('dnsPinnedFetch', () => {
  afterEach(() => {
    httpsRequestMock.mockReset();
  });

  it('connects to pinned IP with Host header preserved', async () => {
    httpsRequestMock.mockImplementation((_options: unknown, callback?: (res: unknown) => void) => {
      const res = {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        on(event: string, handler: (chunk?: Buffer) => void) {
          if (event === 'data') {
            handler(Buffer.from('{"ok":true}'));
          }
          if (event === 'end') {
            handler();
          }
        },
      };
      callback?.(res);
      return { on: vi.fn(), write: vi.fn(), end: vi.fn() };
    });

    const url = new URL('https://api.example.com/openapi.json');
    const response = await dnsPinnedFetch(url, {
      pinRecords: [{ address: '93.184.216.34', family: 4 }],
      headers: { Accept: 'application/json' },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"ok":true}');
    expect(httpsRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        host: '93.184.216.34',
        servername: 'api.example.com',
        headers: expect.objectContaining({ Host: 'api.example.com' }),
      }),
      expect.any(Function),
    );
  });

  it('surfaces DNS failures as DnsPinError', async () => {
    const { lookup } = await import('node:dns/promises');
    vi.mocked(lookup).mockRejectedValueOnce(new Error('ENOTFOUND'));

    await expect(resolvePublicHostAddresses('missing.example.com')).rejects.toBeInstanceOf(
      DnsPinError,
    );
  });
});
