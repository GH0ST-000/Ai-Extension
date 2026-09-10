import type {
  JiraConnectionStatus,
  JiraErrorBody,
  JiraErrorCode,
  JiraIssue,
} from '@project-x/types';

import { USER_FACING_AUTH_ERROR } from '../selection/constants';
import { clearSession, getAccessToken } from './auth-storage';

export class JiraApiError extends Error {
  readonly statusCode: number;
  readonly unauthorized: boolean;
  readonly code: JiraErrorCode | null;

  constructor(message: string, statusCode: number, code: JiraErrorCode | null = null) {
    super(message);
    this.name = 'JiraApiError';
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
): Promise<{ message: string; code: JiraErrorCode | null }> {
  try {
    const body = (await response.json()) as {
      message?: string | string[] | JiraErrorBody;
      code?: JiraErrorCode;
    };
    if (typeof body.code === 'string' && typeof body.message === 'string') {
      return { message: body.message, code: body.code };
    }
    if (body && typeof body.message === 'object' && !Array.isArray(body.message) && body.message) {
      const nested = body.message as JiraErrorBody;
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
    throw new JiraApiError(USER_FACING_AUTH_ERROR, 401, 'JIRA_NOT_CONNECTED');
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
    throw new JiraApiError(USER_FACING_AUTH_ERROR, 401, 'JIRA_NOT_CONNECTED');
  }

  if (!response.ok) {
    const parsed = await parseError(response);
    throw new JiraApiError(parsed.message, response.status, parsed.code);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export function getJiraConnection(): Promise<JiraConnectionStatus> {
  return apiFetch<JiraConnectionStatus>('/settings/jira');
}

export function fetchJiraIssue(
  issueKey: string,
  host?: string,
  signal?: AbortSignal,
): Promise<JiraIssue> {
  const params = host ? `?host=${encodeURIComponent(host)}` : '';
  return apiFetch<JiraIssue>(`/jira/issues/${encodeURIComponent(issueKey)}${params}`, {
    method: 'GET',
    signal,
  });
}
