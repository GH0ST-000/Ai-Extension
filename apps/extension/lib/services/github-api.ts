import type {
  GitHubConnectionStatus,
  PostPullRequestCommentRequest,
  PostPullRequestCommentResponse,
} from '@project-x/types';

import { USER_FACING_AUTH_ERROR } from '../selection/constants';
import { clearSession, getAccessToken } from './auth-storage';

export class GithubApiError extends Error {
  readonly statusCode: number;
  readonly unauthorized: boolean;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'GithubApiError';
    this.statusCode = statusCode;
    this.unauthorized = statusCode === 401;
  }
}

function getApiBaseUrl(): string {
  const configured = process.env.PLASMO_PUBLIC_API_URL?.trim();
  return (configured && configured.length > 0 ? configured : 'http://localhost:3001').replace(
    /\/$/,
    '',
  );
}

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

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const accessToken = await getAccessToken();
  if (!accessToken) {
    throw new GithubApiError(USER_FACING_AUTH_ERROR, 401);
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
  });

  if (response.status === 401) {
    await clearSession();
    throw new GithubApiError(USER_FACING_AUTH_ERROR, 401);
  }

  if (!response.ok) {
    throw new GithubApiError(await parseErrorMessage(response), response.status);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export function getGithubConnection(): Promise<GitHubConnectionStatus> {
  return apiFetch<GitHubConnectionStatus>('/settings/github');
}

export function postPullRequestComment(
  input: PostPullRequestCommentRequest,
): Promise<PostPullRequestCommentResponse> {
  return apiFetch<PostPullRequestCommentResponse>('/github/pull-requests/comments', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function createCommentIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `px-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
