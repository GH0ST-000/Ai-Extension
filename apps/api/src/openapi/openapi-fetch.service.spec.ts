import { HttpException } from '@nestjs/common';
import { OPENAPI_MAX_DOCUMENT_BYTES, OPENAPI_MAX_REDIRECTS } from '@project-x/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OpenApiErrorNormalizer } from './openapi-error-normalizer';
import { OpenApiFetchService } from './openapi-fetch.service';

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]),
}));

function errorBody(err: unknown): { code?: string; message?: string } {
  expect(err).toBeInstanceOf(HttpException);
  const exception = err as HttpException;
  const response = exception.getResponse();
  if (typeof response === 'object' && response !== null) {
    return response as { code?: string; message?: string };
  }
  return {};
}

function jsonResponse(status: number, body: string, headers: Record<string, string> = {}) {
  const encoded = new TextEncoder().encode(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
    arrayBuffer: async () =>
      encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength),
  };
}

describe('OpenApiFetchService', () => {
  const errors = new OpenApiErrorNormalizer();
  let service: OpenApiFetchService;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    service = new OpenApiFetchService(errors);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('throws API_DOC_FETCH_BLOCKED for blocked URLs without calling fetch', async () => {
    await expect(service.fetchDocument('https://127.0.0.1/openapi.json')).rejects.toSatisfy(
      (err: unknown) => errorBody(err).code === 'API_DOC_FETCH_BLOCKED',
    );
    await expect(service.fetchDocument('http://api.example.com/openapi.json')).rejects.toSatisfy(
      (err: unknown) => errorBody(err).code === 'API_DOC_FETCH_BLOCKED',
    );
    await expect(service.fetchDocument('javascript:alert(1)')).rejects.toSatisfy(
      (err: unknown) => errorBody(err).code === 'API_DOC_FETCH_BLOCKED',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('blocks redirect to a private IP', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(302, '', { location: 'https://127.0.0.1/openapi.json' }),
    );

    await expect(service.fetchDocument('https://api.example.com/openapi.json')).rejects.toSatisfy(
      (err: unknown) => errorBody(err).code === 'API_DOC_REDIRECT_BLOCKED',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('enforces redirect count limit', async () => {
    for (let i = 0; i < OPENAPI_MAX_REDIRECTS + 1; i += 1) {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(302, '', {
          location: `https://cdn${i}.example.com/openapi.json`,
        }),
      );
    }

    await expect(service.fetchDocument('https://api.example.com/openapi.json')).rejects.toSatisfy(
      (err: unknown) => errorBody(err).code === 'API_DOC_REDIRECT_BLOCKED',
    );
    expect(fetchMock.mock.calls.length).toBeGreaterThan(OPENAPI_MAX_REDIRECTS);
  });

  it('enforces document size limit', async () => {
    const huge = 'x'.repeat(OPENAPI_MAX_DOCUMENT_BYTES + 10);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, huge));

    await expect(service.fetchDocument('https://api.example.com/openapi.json')).rejects.toSatisfy(
      (err: unknown) => errorBody(err).code === 'API_DOC_TOO_LARGE',
    );
  });

  it('returns content for a successful public fetch', async () => {
    const body = '{"openapi":"3.0.3","info":{"title":"x","version":"1"},"paths":{}}';
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, body, { 'content-type': 'application/json' }),
    );

    const result = await service.fetchDocument(
      'https://api.example.com/openapi.json?token=secret&v=1',
    );
    expect(result.content).toBe(body);
    expect(result.sanitizedUrl).not.toContain('token=');
    expect(result.sanitizedUrl).toContain('v=1');
  });

  it('rejects clearly non-document content types', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, 'not-a-spec', { 'content-type': 'image/png' }),
    );

    await expect(service.fetchDocument('https://api.example.com/openapi.json')).rejects.toSatisfy(
      (err: unknown) => errorBody(err).code === 'API_DOC_INVALID',
    );
  });
});
