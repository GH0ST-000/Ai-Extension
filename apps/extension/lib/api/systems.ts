import type {
  AnalyzeChangeImpactRequest,
  DiscoverRelationshipsResponse,
  MultiRepoArchitectureContext,
  MultiRepoChangeImpactAnalysis,
  MultiRepoErrorBody,
  MultiRepoErrorCode,
  MultiRepoEvidence,
  MultiRepoRequirementCoverage,
  ProjectSystem,
  RelationshipConfidence,
  RepositoryIdentity,
  RepositoryRelationship,
  SystemFlowTrace,
  TraceSystemFlowRequest,
} from '@project-x/types';

import { USER_FACING_AUTH_ERROR } from '../selection/constants';
import { clearSession, getAccessToken } from '../services/auth-storage';

export class MultiRepoApiError extends Error {
  readonly statusCode: number;
  readonly unauthorized: boolean;
  readonly code: MultiRepoErrorCode | null;

  constructor(message: string, statusCode: number, code: MultiRepoErrorCode | null = null) {
    super(message);
    this.name = 'MultiRepoApiError';
    this.statusCode = statusCode;
    this.unauthorized = statusCode === 401;
    this.code = code;
  }
}

export type RefreshSystemResponse = {
  analyzed: number;
  relationshipsChecked: number;
  candidates: DiscoverRelationshipsResponse['candidates'];
  unavailable: RepositoryIdentity[];
  truncated: boolean;
};

export type CompareRequirementRequest = {
  systemId: string;
  issueKey: string;
  criteria?: string[];
};

export type FindApiConsumersRequest = {
  method?: string;
  path: string;
  operationId?: string;
};

export type FindEventConsumersRequest = {
  topic: string;
  eventType?: string;
};

export type FindConsumersResponse = {
  consumers: Array<{
    repository: RepositoryIdentity;
    confidence: RelationshipConfidence;
    evidence?: MultiRepoEvidence[];
    summary?: string;
  }>;
};

function getApiBaseUrl(): string {
  const configured = process.env.PLASMO_PUBLIC_API_URL?.trim();
  return (configured && configured.length > 0 ? configured : 'http://localhost:3001').replace(
    /\/$/,
    '',
  );
}

function systemsPath(suffix = ''): string {
  return `/systems${suffix}`;
}

async function parseError(
  response: Response,
): Promise<{ message: string; code: MultiRepoErrorCode | null }> {
  try {
    const body = (await response.json()) as {
      message?: string | string[] | MultiRepoErrorBody;
      code?: MultiRepoErrorCode;
    };
    if (typeof body.code === 'string' && typeof body.message === 'string') {
      return { message: body.message, code: body.code };
    }
    if (body && typeof body.message === 'object' && !Array.isArray(body.message) && body.message) {
      const nested = body.message as MultiRepoErrorBody;
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
    throw new MultiRepoApiError(USER_FACING_AUTH_ERROR, 401, 'SYSTEM_CONTEXT_NOT_CONFIGURED');
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
    throw new MultiRepoApiError(USER_FACING_AUTH_ERROR, 401, 'SYSTEM_CONTEXT_NOT_CONFIGURED');
  }

  if (!response.ok) {
    const parsed = await parseError(response);
    throw new MultiRepoApiError(parsed.message, response.status, parsed.code);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export function listSystems(signal?: AbortSignal): Promise<ProjectSystem[]> {
  return apiFetch<ProjectSystem[]>(systemsPath(), { method: 'GET', signal });
}

export function getSystem(systemId: string, signal?: AbortSignal): Promise<ProjectSystem> {
  return apiFetch<ProjectSystem>(systemsPath(`/${encodeURIComponent(systemId)}`), {
    method: 'GET',
    signal,
  });
}

export function getSystemContext(
  systemId: string,
  signal?: AbortSignal,
): Promise<MultiRepoArchitectureContext> {
  return apiFetch<MultiRepoArchitectureContext>(
    systemsPath(`/${encodeURIComponent(systemId)}/context`),
    { method: 'GET', signal },
  );
}

export function refreshSystem(
  systemId: string,
  signal?: AbortSignal,
): Promise<RefreshSystemResponse> {
  return apiFetch<RefreshSystemResponse>(systemsPath(`/${encodeURIComponent(systemId)}/refresh`), {
    method: 'POST',
    signal,
  });
}

export function listRelationships(
  systemId: string,
  signal?: AbortSignal,
): Promise<RepositoryRelationship[]> {
  return apiFetch<RepositoryRelationship[]>(
    systemsPath(`/${encodeURIComponent(systemId)}/relationships`),
    { method: 'GET', signal },
  );
}

export function discoverRelationships(
  systemId: string,
  signal?: AbortSignal,
): Promise<DiscoverRelationshipsResponse> {
  return apiFetch<DiscoverRelationshipsResponse>(
    systemsPath(`/${encodeURIComponent(systemId)}/relationships/discover`),
    { method: 'POST', signal },
  );
}

export function analyzeChangeImpact(
  body: AnalyzeChangeImpactRequest,
  signal?: AbortSignal,
): Promise<MultiRepoChangeImpactAnalysis> {
  return apiFetch<MultiRepoChangeImpactAnalysis>(
    systemsPath(`/${encodeURIComponent(body.systemId)}/analyze-change-impact`),
    {
      method: 'POST',
      body: JSON.stringify(body),
      signal,
    },
  );
}

export function traceSystemFlow(
  body: TraceSystemFlowRequest,
  signal?: AbortSignal,
): Promise<SystemFlowTrace> {
  return apiFetch<SystemFlowTrace>(
    systemsPath(`/${encodeURIComponent(body.systemId)}/trace-system-flow`),
    {
      method: 'POST',
      body: JSON.stringify(body),
      signal,
    },
  );
}

export function compareRequirement(
  body: CompareRequirementRequest,
  signal?: AbortSignal,
): Promise<MultiRepoRequirementCoverage> {
  return apiFetch<MultiRepoRequirementCoverage>(
    systemsPath(`/${encodeURIComponent(body.systemId)}/compare-requirement`),
    {
      method: 'POST',
      body: JSON.stringify(body),
      signal,
    },
  );
}

export function findApiConsumers(
  systemId: string,
  body: FindApiConsumersRequest,
  signal?: AbortSignal,
): Promise<FindConsumersResponse> {
  return apiFetch<FindConsumersResponse>(
    systemsPath(`/${encodeURIComponent(systemId)}/find-api-consumers`),
    {
      method: 'POST',
      body: JSON.stringify(body),
      signal,
    },
  );
}

export function findEventConsumers(
  systemId: string,
  body: FindEventConsumersRequest,
  signal?: AbortSignal,
): Promise<FindConsumersResponse> {
  return apiFetch<FindConsumersResponse>(
    systemsPath(`/${encodeURIComponent(systemId)}/find-event-consumers`),
    {
      method: 'POST',
      body: JSON.stringify(body),
      signal,
    },
  );
}
