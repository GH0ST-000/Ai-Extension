import type {
  AuthTokenResponse,
  AuthUser,
  CreateProjectMemoryRuleRequest,
  GitHubConnectionStatus,
  JiraConnectionStatus,
  LearnProjectMemoryResponse,
  ListProjectMemoryResponse,
  LoginRequest,
  ProjectMemoryItem,
  ProjectProfile,
  RegisterRequest,
  UpdateProjectMemoryRequest,
  UpdateUserSettingsRequest,
  UpsertGitHubConnectionRequest,
  UpsertJiraConnectionRequest,
  UserSettings,
} from '@project-x/types';

import { clearSession, getAccessToken, setSession } from './auth-storage';

export function getApiBaseUrl(): string {
  const configured = process.env.NEXT_PUBLIC_API_URL?.trim();
  return (configured && configured.length > 0 ? configured : 'http://localhost:3001').replace(
    /\/$/,
    '',
  );
}

export class ApiError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
  }
}

export type ServiceHealthStatus = 'up' | 'down';

export type TerminusHealthResponse = {
  status: 'ok' | 'error' | 'shutting_down';
  info?: Record<string, { status: ServiceHealthStatus }>;
  error?: Record<string, { status: ServiceHealthStatus }>;
  details?: Record<string, { status: ServiceHealthStatus }>;
};

async function parseErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string | string[] };
    if (Array.isArray(body.message)) {
      return body.message.join(', ');
    }
    if (typeof body.message === 'string' && body.message.trim()) {
      return body.message;
    }
  } catch {
    // ignore
  }
  return 'Request failed.';
}

export async function fetchApiHealth(): Promise<TerminusHealthResponse> {
  const response = await fetch(`${getApiBaseUrl()}/api/health`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new ApiError(await parseErrorMessage(response), response.status);
  }

  return (await response.json()) as TerminusHealthResponse;
}

async function apiFetch<T>(path: string, init?: RequestInit & { auth?: boolean }): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has('Content-Type') && init?.body) {
    headers.set('Content-Type', 'application/json');
  }

  if (init?.auth !== false) {
    const token = getAccessToken();
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }
  }

  const response = await fetch(`${getApiBaseUrl()}/api${path}`, {
    ...init,
    headers,
  });

  if (response.status === 401) {
    clearSession();
  }

  if (!response.ok) {
    throw new ApiError(await parseErrorMessage(response), response.status);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export async function register(input: RegisterRequest): Promise<AuthTokenResponse> {
  const result = await apiFetch<AuthTokenResponse>('/auth/register', {
    method: 'POST',
    body: JSON.stringify(input),
    auth: false,
  });
  setSession(result.accessToken, result.user);
  return result;
}

export async function login(input: LoginRequest): Promise<AuthTokenResponse> {
  const result = await apiFetch<AuthTokenResponse>('/auth/login', {
    method: 'POST',
    body: JSON.stringify(input),
    auth: false,
  });
  setSession(result.accessToken, result.user);
  return result;
}

export async function fetchMe(): Promise<AuthUser> {
  const result = await apiFetch<{ user: AuthUser }>('/auth/me');
  return result.user;
}

export async function getSettings(): Promise<UserSettings> {
  return apiFetch<UserSettings>('/settings');
}

export async function updateSettings(input: UpdateUserSettingsRequest): Promise<UserSettings> {
  return apiFetch<UserSettings>('/settings', {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function getGithubConnection(): Promise<GitHubConnectionStatus> {
  return apiFetch<GitHubConnectionStatus>('/settings/github');
}

export async function upsertGithubConnection(
  input: UpsertGitHubConnectionRequest,
): Promise<GitHubConnectionStatus> {
  return apiFetch<GitHubConnectionStatus>('/settings/github', {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export async function deleteGithubConnection(): Promise<void> {
  await apiFetch<void>('/settings/github', {
    method: 'DELETE',
  });
}

export async function getJiraConnection(): Promise<JiraConnectionStatus> {
  return apiFetch<JiraConnectionStatus>('/settings/jira');
}

export async function upsertJiraConnection(
  input: UpsertJiraConnectionRequest,
): Promise<JiraConnectionStatus> {
  return apiFetch<JiraConnectionStatus>('/settings/jira', {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export async function deleteJiraConnection(): Promise<void> {
  await apiFetch<void>('/settings/jira', {
    method: 'DELETE',
  });
}

function projectMemoryPath(owner: string, repo: string, suffix = ''): string {
  return `/projects/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/memory${suffix}`;
}

export type CreateProjectMemoryRuleBody = Omit<
  CreateProjectMemoryRuleRequest,
  'owner' | 'repository'
>;

export async function listProjectMemory(
  owner: string,
  repo: string,
): Promise<ListProjectMemoryResponse> {
  return apiFetch<ListProjectMemoryResponse>(projectMemoryPath(owner, repo));
}

export async function getProjectMemoryProfile(
  owner: string,
  repo: string,
): Promise<ProjectProfile> {
  return apiFetch<ProjectProfile>(projectMemoryPath(owner, repo, '/profile'));
}

export async function createProjectMemoryRule(
  owner: string,
  repo: string,
  body: CreateProjectMemoryRuleBody,
): Promise<ProjectMemoryItem> {
  return apiFetch<ProjectMemoryItem>(projectMemoryPath(owner, repo, '/rules'), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function updateProjectMemory(
  owner: string,
  repo: string,
  id: string,
  body: UpdateProjectMemoryRequest,
): Promise<ProjectMemoryItem> {
  return apiFetch<ProjectMemoryItem>(projectMemoryPath(owner, repo, `/${encodeURIComponent(id)}`), {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function clearProjectMemory(
  owner: string,
  repo: string,
): Promise<{ archived: number }> {
  return apiFetch<{ archived: number }>(projectMemoryPath(owner, repo, '/clear'), {
    method: 'POST',
    body: JSON.stringify({ confirm: true }),
  });
}

export async function learnProjectMemory(
  owner: string,
  repo: string,
): Promise<LearnProjectMemoryResponse> {
  return apiFetch<LearnProjectMemoryResponse>(projectMemoryPath(owner, repo, '/learn'), {
    method: 'POST',
  });
}

export async function confirmMemoryCandidate(
  owner: string,
  repo: string,
  candidateId: string,
): Promise<ProjectMemoryItem> {
  return apiFetch<ProjectMemoryItem>(projectMemoryPath(owner, repo, '/candidates/confirm'), {
    method: 'POST',
    body: JSON.stringify({ candidateId }),
  });
}

export async function rejectMemoryCandidate(
  owner: string,
  repo: string,
  candidateId: string,
): Promise<{ rejected: true; candidateId: string }> {
  return apiFetch<{ rejected: true; candidateId: string }>(
    projectMemoryPath(owner, repo, '/candidates/reject'),
    {
      method: 'POST',
      body: JSON.stringify({ candidateId }),
    },
  );
}
