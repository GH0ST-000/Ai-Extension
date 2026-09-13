import type {
  WorkspaceBootstrapResponse,
  WorkspaceErrorBody,
  WorkspaceErrorCode,
} from '@project-x/types';

import { USER_FACING_AUTH_ERROR } from '../selection/constants';
import { clearSession, getAccessToken } from '../services/auth-storage';
import { getCurrentWorkspaceId } from '../workspace/current-workspace-id';

export class WorkspaceApiError extends Error {
  readonly statusCode: number;
  readonly unauthorized: boolean;
  readonly code: WorkspaceErrorCode | null;

  constructor(message: string, statusCode: number, code: WorkspaceErrorCode | null = null) {
    super(message);
    this.name = 'WorkspaceApiError';
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

async function parseError(
  response: Response,
): Promise<{ message: string; code: WorkspaceErrorCode | null }> {
  try {
    const body = (await response.json()) as {
      message?: string | string[] | WorkspaceErrorBody;
      code?: WorkspaceErrorCode;
    };

    if (typeof body.code === 'string' && typeof body.message === 'string') {
      return { message: body.message, code: body.code };
    }

    if (body && typeof body.message === 'object' && !Array.isArray(body.message) && body.message) {
      const nested = body.message as WorkspaceErrorBody;
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
  return { message: 'Workspace request failed.', code: null };
}

/** Attach X-Workspace-Id when a current workspace is known. */
export async function applyWorkspaceHeader(headers: Headers): Promise<void> {
  const workspaceId = await getCurrentWorkspaceId();
  if (workspaceId && !headers.has('X-Workspace-Id')) {
    headers.set('X-Workspace-Id', workspaceId);
  }
}

async function apiFetch<T>(
  path: string,
  init?: RequestInit,
  options?: { skipWorkspaceHeader?: boolean },
): Promise<T> {
  const accessToken = await getAccessToken();
  if (!accessToken) {
    throw new WorkspaceApiError(USER_FACING_AUTH_ERROR, 401, 'WORKSPACE_ACCESS_DENIED');
  }

  const headers = new Headers(init?.headers);
  if (!headers.has('Content-Type') && init?.body) {
    headers.set('Content-Type', 'application/json');
  }
  headers.set('Authorization', `Bearer ${accessToken}`);
  headers.set('Accept', 'application/json');
  if (!options?.skipWorkspaceHeader) {
    await applyWorkspaceHeader(headers);
  }

  const response = await fetch(`${getApiBaseUrl()}/api${path}`, {
    ...init,
    headers,
    signal: init?.signal,
  });

  if (response.status === 401) {
    await clearSession();
    throw new WorkspaceApiError(USER_FACING_AUTH_ERROR, 401, 'WORKSPACE_ACCESS_DENIED');
  }

  if (!response.ok) {
    const parsed = await parseError(response);
    throw new WorkspaceApiError(parsed.message, response.status, parsed.code);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export type WorkspaceListItem = WorkspaceBootstrapResponse['workspaces'][number];

export type FetchWorkspaceBootstrapOptions = {
  /** Preferred workspace; sent as X-Workspace-Id and optional query for server fallback. */
  workspaceId?: string | null;
  signal?: AbortSignal;
};

/**
 * GET /api/workspaces/bootstrap — user, memberships, current context + entitlements.
 */
export async function fetchWorkspaceBootstrap(
  options?: FetchWorkspaceBootstrapOptions,
): Promise<WorkspaceBootstrapResponse> {
  const preferred = options?.workspaceId?.trim() || (await getCurrentWorkspaceId());
  const headers = new Headers();
  if (preferred) {
    headers.set('X-Workspace-Id', preferred);
  }

  const query = preferred ? `?workspaceId=${encodeURIComponent(preferred)}` : '';
  return apiFetch<WorkspaceBootstrapResponse>(
    `/workspaces/bootstrap${query}`,
    { method: 'GET', headers, signal: options?.signal },
    { skipWorkspaceHeader: true },
  );
}

/** Convenience: workspace list from bootstrap (no separate list round-trip required). */
export async function listWorkspaces(signal?: AbortSignal): Promise<WorkspaceListItem[]> {
  const bootstrap = await fetchWorkspaceBootstrap({ signal });
  return bootstrap.workspaces;
}

/**
 * Switch helper: bootstrap with an explicit workspace id.
 * Persistence / session clearing is owned by the workspace store.
 */
export async function switchWorkspaceBootstrap(
  workspaceId: string,
  signal?: AbortSignal,
): Promise<WorkspaceBootstrapResponse> {
  return fetchWorkspaceBootstrap({ workspaceId, signal });
}
