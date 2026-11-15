import type { PrReviewHistoryPersistence, PrReviewReportDetail } from '@project-x/types';

import { getCurrentWorkspaceId } from '../workspace/current-workspace-id';
import { extensionApiFetch } from './background-http';

export class PrReviewHistoryError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'PrReviewHistoryError';
  }
}

/**
 * Latest saved review of a PR in the active workspace, or null when there is none.
 * Read-only: no AI call, no usage charge, no GitHub write.
 */
export async function fetchLatestSavedPrReview(input: {
  owner: string;
  repository: string;
  pullRequestNumber: number;
}): Promise<PrReviewReportDetail | null> {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    throw new PrReviewHistoryError('Choose a workspace in Project X to see saved reviews.', 0);
  }
  const params = new URLSearchParams({
    owner: input.owner,
    repository: input.repository,
    pullRequestNumber: String(input.pullRequestNumber),
  });
  const response = await extensionApiFetch(
    `/workspaces/${encodeURIComponent(workspaceId)}/pr-reviews/latest?${params.toString()}`,
    { method: 'GET', headers: { 'X-Workspace-Id': workspaceId } },
  );
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new PrReviewHistoryError(savedReviewErrorMessage(response.status), response.status);
  }
  const body = (await response.json()) as { report: PrReviewReportDetail | null };
  return body.report ?? null;
}

export function savedReviewErrorMessage(status: number): string {
  if (status === 401) return 'Sign in to Project X to see saved reviews.';
  if (status === 403) return 'Your workspace role cannot view saved reviews.';
  if (status === 503) return 'GitHub could not confirm repository access right now. Try again.';
  return 'Saved reviews are unavailable right now. Try again.';
}

/**
 * Whether this user's review operation was saved to history, as answered by the server from
 * PostgreSQL. Throws on transport / server errors (the caller must then not claim anything).
 */
export async function fetchReviewHistoryStatus(
  operationId: string,
): Promise<PrReviewHistoryPersistence> {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) throw new PrReviewHistoryError('No workspace selected.', 0);
  const response = await extensionApiFetch(
    `/workspaces/${encodeURIComponent(workspaceId)}/pr-reviews/operations/${encodeURIComponent(operationId)}`,
    { method: 'GET', headers: { 'X-Workspace-Id': workspaceId } },
  );
  if (!response.ok) {
    throw new PrReviewHistoryError(savedReviewErrorMessage(response.status), response.status);
  }
  const body = (await response.json()) as Partial<PrReviewHistoryPersistence>;
  if (body.status === 'saved' && typeof (body as { reportId?: unknown }).reportId === 'string') {
    return { status: 'saved', reportId: (body as { reportId: string }).reportId };
  }
  return body.status === 'not_saved' ? { status: 'not_saved' } : { status: 'unknown' };
}
