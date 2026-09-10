import type {
  AnalyzeCIFailureRequest,
  AnalyzeCIFailureResponse,
  ApplyPullRequestPatchRequest,
  ApplyPullRequestPatchResponse,
  CICheckFailureEvidence,
  GitHubConnectionStatus,
  GitHubWriteErrorBody,
  GitHubWriteErrorCode,
  PostPullRequestCommentRequest,
  PostPullRequestCommentResponse,
  PreparePullRequestPatchRequest,
  PreparePullRequestPatchResponse,
  PullRequestCISummary,
  SubmitPullRequestReviewRequest,
  SubmitPullRequestReviewResponse,
} from '@project-x/types';

import { USER_FACING_AUTH_ERROR } from '../selection/constants';
import { clearSession, getAccessToken } from './auth-storage';

export class GithubApiError extends Error {
  readonly statusCode: number;
  readonly unauthorized: boolean;
  readonly code: GitHubWriteErrorCode | null;

  constructor(message: string, statusCode: number, code: GitHubWriteErrorCode | null = null) {
    super(message);
    this.name = 'GithubApiError';
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
): Promise<{ message: string; code: GitHubWriteErrorCode | null }> {
  try {
    const body = (await response.json()) as {
      message?: string | string[] | GitHubWriteErrorBody;
      code?: GitHubWriteErrorCode;
      statusCode?: number;
    };

    if (typeof body.code === 'string' && typeof body.message === 'string') {
      return { message: body.message, code: body.code };
    }

    if (body && typeof body.message === 'object' && !Array.isArray(body.message) && body.message) {
      const nested = body.message as GitHubWriteErrorBody;
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
    throw new GithubApiError(USER_FACING_AUTH_ERROR, 401, 'NOT_CONNECTED');
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
    throw new GithubApiError(USER_FACING_AUTH_ERROR, 401, 'NOT_CONNECTED');
  }

  if (!response.ok) {
    const parsed = await parseError(response);
    throw new GithubApiError(parsed.message, response.status, parsed.code);
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

export function submitPullRequestReview(
  owner: string,
  repository: string,
  pullRequestNumber: number,
  input: SubmitPullRequestReviewRequest,
): Promise<SubmitPullRequestReviewResponse> {
  return apiFetch<SubmitPullRequestReviewResponse>(
    `/github/pull-requests/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/${pullRequestNumber}/reviews`,
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
  );
}

export function preparePullRequestPatch(
  owner: string,
  repository: string,
  pullRequestNumber: number,
  input: PreparePullRequestPatchRequest,
): Promise<PreparePullRequestPatchResponse> {
  return apiFetch<PreparePullRequestPatchResponse>(
    `/github/pull-requests/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/${pullRequestNumber}/patches/prepare`,
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
  );
}

export function applyPullRequestPatch(
  owner: string,
  repository: string,
  pullRequestNumber: number,
  input: ApplyPullRequestPatchRequest,
): Promise<ApplyPullRequestPatchResponse> {
  return apiFetch<ApplyPullRequestPatchResponse>(
    `/github/pull-requests/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/${pullRequestNumber}/patches/apply`,
    {
      method: 'POST',
      body: JSON.stringify(input),
    },
  );
}

function checksBase(owner: string, repository: string, pullRequestNumber: number): string {
  return `/github/pull-requests/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/${pullRequestNumber}/checks`;
}

export function fetchPullRequestChecks(
  owner: string,
  repository: string,
  pullRequestNumber: number,
  signal?: AbortSignal,
): Promise<PullRequestCISummary> {
  return apiFetch<PullRequestCISummary>(checksBase(owner, repository, pullRequestNumber), {
    method: 'GET',
    signal,
  });
}

export function fetchCheckFailureEvidence(
  owner: string,
  repository: string,
  pullRequestNumber: number,
  checkId: string,
  signal?: AbortSignal,
): Promise<CICheckFailureEvidence> {
  return apiFetch<CICheckFailureEvidence>(
    `${checksBase(owner, repository, pullRequestNumber)}/${encodeURIComponent(checkId)}`,
    { method: 'GET', signal },
  );
}

export function analyzeCheckFailure(
  owner: string,
  repository: string,
  pullRequestNumber: number,
  checkId: string,
  input: AnalyzeCIFailureRequest,
  signal?: AbortSignal,
): Promise<AnalyzeCIFailureResponse> {
  return apiFetch<AnalyzeCIFailureResponse>(
    `${checksBase(owner, repository, pullRequestNumber)}/${encodeURIComponent(checkId)}/analyze`,
    {
      method: 'POST',
      body: JSON.stringify(input),
      signal,
    },
  );
}

export function createCommentIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `px-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
