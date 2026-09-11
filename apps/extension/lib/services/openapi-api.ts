import type {
  ApiContractAnalysis,
  ApiContractDiff,
  ApiGeneratedExample,
  HttpMethod,
  NormalizedApiContract,
  OpenApiErrorBody,
  OpenApiErrorCode,
} from '@project-x/types';

import { USER_FACING_AUTH_ERROR } from '../selection/constants';
import { clearSession, getAccessToken } from './auth-storage';

export class OpenApiApiError extends Error {
  readonly statusCode: number;
  readonly unauthorized: boolean;
  readonly code: OpenApiErrorCode | null;

  constructor(message: string, statusCode: number, code: OpenApiErrorCode | null = null) {
    super(message);
    this.name = 'OpenApiApiError';
    this.statusCode = statusCode;
    this.unauthorized = statusCode === 401;
    this.code = code;
  }
}

export type OpenApiOperationQuery = {
  id?: string;
  method?: HttpMethod | string;
  path?: string;
  operationId?: string;
};

function getApiBaseUrl(): string {
  const configured = process.env.PLASMO_PUBLIC_API_URL?.trim();
  return (configured && configured.length > 0 ? configured : 'http://localhost:3001').replace(
    /\/$/,
    '',
  );
}

async function parseError(
  response: Response,
): Promise<{ message: string; code: OpenApiErrorCode | null }> {
  try {
    const body = (await response.json()) as {
      message?: string | string[] | OpenApiErrorBody;
      code?: OpenApiErrorCode;
    };
    if (typeof body.code === 'string' && typeof body.message === 'string') {
      return { message: body.message, code: body.code };
    }
    if (body && typeof body.message === 'object' && !Array.isArray(body.message) && body.message) {
      const nested = body.message as OpenApiErrorBody;
      if (typeof nested.message === 'string') {
        return { message: nested.message, code: nested.code ?? null };
      }
    }
    if (Array.isArray(body.message)) {
      return { message: body.message.join(', '), code: null };
    }
    if (typeof body.message === 'string' && body.message.trim()) {
      return { message: body.message, code: null };
    }
  } catch {
    // ignore
  }
  return { message: 'Request failed.', code: null };
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const accessToken = await getAccessToken();
  if (!accessToken) {
    throw new OpenApiApiError(USER_FACING_AUTH_ERROR, 401, 'UNKNOWN');
  }

  const headers = new Headers(init?.headers);
  if (!headers.has('Content-Type') && init?.body) {
    headers.set('Content-Type', 'application/json');
  }
  headers.set('Authorization', `Bearer ${accessToken}`);
  headers.set('Accept', 'application/json');

  const response = await fetch(`${getApiBaseUrl()}/api${path}`, {
    ...init,
    headers,
    signal: init?.signal,
  });

  if (response.status === 401) {
    await clearSession();
    throw new OpenApiApiError(USER_FACING_AUTH_ERROR, 401, 'UNKNOWN');
  }

  if (!response.ok) {
    const parsed = await parseError(response);
    throw new OpenApiApiError(parsed.message, response.status, parsed.code);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export function parseOpenApiUrl(url: string, signal?: AbortSignal): Promise<NormalizedApiContract> {
  return apiFetch<NormalizedApiContract>('/openapi/parse-url', {
    method: 'POST',
    body: JSON.stringify({ url }),
    signal,
  });
}

export function parseOpenApiContent(
  content: string,
  sourceUrl?: string,
  signal?: AbortSignal,
): Promise<NormalizedApiContract> {
  return apiFetch<NormalizedApiContract>('/openapi/parse-content', {
    method: 'POST',
    body: JSON.stringify({
      content,
      ...(sourceUrl ? { sourceUrl } : {}),
    }),
    signal,
  });
}

export function generateOpenApiExample(input: {
  content: string;
  operation: OpenApiOperationQuery;
  sourceUrl?: string;
  signal?: AbortSignal;
}): Promise<ApiGeneratedExample> {
  return apiFetch<ApiGeneratedExample>('/openapi/example', {
    method: 'POST',
    body: JSON.stringify({
      content: input.content,
      operation: input.operation,
      ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
    }),
    signal: input.signal,
  });
}

export function fetchOpenApiRisks(input: {
  content: string;
  scope: 'operation' | 'tag' | 'contract';
  operation?: OpenApiOperationQuery;
  tag?: string;
  sourceUrl?: string;
  signal?: AbortSignal;
}): Promise<ApiContractAnalysis & { documentHash?: string }> {
  return apiFetch<ApiContractAnalysis & { documentHash?: string }>('/openapi/risks', {
    method: 'POST',
    body: JSON.stringify({
      content: input.content,
      scope: input.scope,
      ...(input.operation ? { operation: input.operation } : {}),
      ...(input.tag ? { tag: input.tag } : {}),
      ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}),
    }),
    signal: input.signal,
  });
}

export function diffOpenApiContracts(input: {
  baseContent: string;
  headContent: string;
  baseRef: string;
  headRef: string;
  signal?: AbortSignal;
}): Promise<ApiContractDiff> {
  return apiFetch<ApiContractDiff>('/openapi/diff', {
    method: 'POST',
    body: JSON.stringify({
      baseContent: input.baseContent,
      headContent: input.headContent,
      baseRef: input.baseRef,
      headRef: input.headRef,
    }),
    signal: input.signal,
  });
}
