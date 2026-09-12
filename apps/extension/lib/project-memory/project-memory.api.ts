import type {
  CreateProjectMemoryRuleRequest,
  LearnProjectMemoryResponse,
  ListProjectMemoryResponse,
  ProjectMemoryErrorBody,
  ProjectMemoryErrorCode,
  ProjectMemoryItem,
  ProjectMemoryStatus,
  ProjectMemorySummary,
  UpdateProjectMemoryRequest,
} from '@project-x/types';

import { USER_FACING_AUTH_ERROR } from '../selection/constants';
import { clearSession, getAccessToken } from '../services/auth-storage';

export class ProjectMemoryApiError extends Error {
  readonly statusCode: number;
  readonly unauthorized: boolean;
  readonly code: ProjectMemoryErrorCode | null;

  constructor(message: string, statusCode: number, code: ProjectMemoryErrorCode | null = null) {
    super(message);
    this.name = 'ProjectMemoryApiError';
    this.statusCode = statusCode;
    this.unauthorized = statusCode === 401;
    this.code = code;
  }
}

function getApiBaseUrl(): string {
  const configured = process.env.PLASMO_PUBLIC_API_URL?.trim();
  return (configured && configured.length > 0 ? configured : 'http://localhost:3001').replace(
    /\/$/,
    '',
  );
}

function memoryBase(owner: string, repo: string): string {
  return `/projects/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/memory`;
}

async function parseError(
  response: Response,
): Promise<{ message: string; code: ProjectMemoryErrorCode | null }> {
  try {
    const body = (await response.json()) as {
      message?: string | string[] | ProjectMemoryErrorBody;
      code?: ProjectMemoryErrorCode;
    };

    if (typeof body.code === 'string' && typeof body.message === 'string') {
      return { message: body.message, code: body.code };
    }

    if (body && typeof body.message === 'object' && !Array.isArray(body.message) && body.message) {
      const nested = body.message as ProjectMemoryErrorBody;
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
    throw new ProjectMemoryApiError(USER_FACING_AUTH_ERROR, 401, 'PROJECT_MEMORY_ACCESS_DENIED');
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
    throw new ProjectMemoryApiError(USER_FACING_AUTH_ERROR, 401, 'PROJECT_MEMORY_ACCESS_DENIED');
  }

  if (!response.ok) {
    const parsed = await parseError(response);
    throw new ProjectMemoryApiError(parsed.message, response.status, parsed.code);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export type FetchProjectMemorySummaryOptions = {
  capability: string;
  paths?: string[];
  signal?: AbortSignal;
};

export function fetchProjectMemorySummary(
  owner: string,
  repo: string,
  options: FetchProjectMemorySummaryOptions,
): Promise<ProjectMemorySummary> {
  const params = new URLSearchParams();
  params.set('capability', options.capability);
  if (options.paths && options.paths.length > 0) {
    params.set('paths', options.paths.join(','));
  }
  return apiFetch<ProjectMemorySummary>(`${memoryBase(owner, repo)}/summary?${params.toString()}`, {
    method: 'GET',
    signal: options.signal,
  });
}

export function fetchProjectMemoryList(
  owner: string,
  repo: string,
  options?: { status?: ProjectMemoryStatus; signal?: AbortSignal },
): Promise<ListProjectMemoryResponse> {
  const params = new URLSearchParams();
  if (options?.status) {
    params.set('status', options.status);
  }
  const query = params.toString();
  return apiFetch<ListProjectMemoryResponse>(
    `${memoryBase(owner, repo)}${query ? `?${query}` : ''}`,
    { method: 'GET', signal: options?.signal },
  );
}

export function learnProjectMemory(
  owner: string,
  repo: string,
  signal?: AbortSignal,
): Promise<LearnProjectMemoryResponse> {
  return apiFetch<LearnProjectMemoryResponse>(`${memoryBase(owner, repo)}/learn`, {
    method: 'POST',
    signal,
  });
}

export function createProjectMemoryRule(
  owner: string,
  repo: string,
  body: Omit<CreateProjectMemoryRuleRequest, 'owner' | 'repository'>,
  signal?: AbortSignal,
): Promise<ProjectMemoryItem> {
  return apiFetch<ProjectMemoryItem>(`${memoryBase(owner, repo)}/rules`, {
    method: 'POST',
    body: JSON.stringify(body),
    signal,
  });
}

export function updateProjectMemory(
  owner: string,
  repo: string,
  memoryId: string,
  body: UpdateProjectMemoryRequest,
  signal?: AbortSignal,
): Promise<ProjectMemoryItem> {
  return apiFetch<ProjectMemoryItem>(`${memoryBase(owner, repo)}/${encodeURIComponent(memoryId)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
    signal,
  });
}

export function clearProjectMemory(
  owner: string,
  repo: string,
  confirm: true,
  signal?: AbortSignal,
): Promise<{ archived: number }> {
  return apiFetch<{ archived: number }>(`${memoryBase(owner, repo)}/clear`, {
    method: 'POST',
    body: JSON.stringify({ confirm }),
    signal,
  });
}

export function confirmProjectMemoryCandidate(
  owner: string,
  repo: string,
  candidateId: string,
  signal?: AbortSignal,
): Promise<ProjectMemoryItem> {
  return apiFetch<ProjectMemoryItem>(`${memoryBase(owner, repo)}/candidates/confirm`, {
    method: 'POST',
    body: JSON.stringify({ candidateId }),
    signal,
  });
}

export function rejectProjectMemoryCandidate(
  owner: string,
  repo: string,
  candidateId: string,
  signal?: AbortSignal,
): Promise<{ rejected: true; candidateId: string }> {
  return apiFetch<{ rejected: true; candidateId: string }>(
    `${memoryBase(owner, repo)}/candidates/reject`,
    {
      method: 'POST',
      body: JSON.stringify({ candidateId }),
      signal,
    },
  );
}

/** Parse `owner/repo` (optionally with extra path segments ignored). */
export function parseOwnerRepo(
  repository: string | null | undefined,
): { owner: string; repo: string } | null {
  if (!repository) {
    return null;
  }
  const trimmed = repository.trim().replace(/^\/+|\/+$/g, '');
  const parts = trimmed.split('/').filter(Boolean);
  if (parts.length < 2) {
    return null;
  }
  const owner = parts[0];
  const repo = parts[1];
  if (!owner || !repo) {
    return null;
  }
  return { owner, repo };
}
