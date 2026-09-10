import { createHash } from 'node:crypto';

import type {
  GitHubReviewDiffSide,
  GitHubReviewEvent,
  SubmitPullRequestReviewRequest,
} from '@project-x/types';

/**
 * Deterministic fingerprint for review submission idempotency.
 * Never log the full private review body from this helper's callers.
 */
export function buildReviewSubmissionFingerprint(input: {
  owner: string;
  repository: string;
  pullRequestNumber: number;
  event: GitHubReviewEvent;
  body: string;
  comments: Array<{
    body: string;
    path?: string;
    line?: number;
    side?: GitHubReviewDiffSide;
    startLine?: number;
    startSide?: GitHubReviewDiffSide;
  }>;
}): string {
  const normalized = {
    owner: input.owner.trim().toLowerCase(),
    repository: input.repository.trim().toLowerCase(),
    pullRequestNumber: input.pullRequestNumber,
    event: input.event,
    body: input.body.trim(),
    comments: input.comments.map((comment) => ({
      body: comment.body.trim(),
      path: comment.path?.trim() ?? null,
      line: comment.line ?? null,
      side: comment.side ?? null,
      startLine: comment.startLine ?? null,
      startSide: comment.startSide ?? null,
    })),
  };

  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

export function reviewRequestFingerprint(
  owner: string,
  repository: string,
  pullRequestNumber: number,
  body: SubmitPullRequestReviewRequest,
): string {
  return buildReviewSubmissionFingerprint({
    owner,
    repository,
    pullRequestNumber,
    event: body.event,
    body: body.body ?? '',
    comments: body.comments,
  });
}
