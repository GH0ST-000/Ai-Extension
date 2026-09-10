import type {
  GitHubReviewDraft,
  GitHubReviewEvent,
  GitHubReviewSubmissionSnapshot,
  SubmitPullRequestReviewRequest,
} from '@project-x/types';
import {
  GITHUB_REVIEW_MAX_BODY_CHARACTERS,
  GITHUB_REVIEW_MAX_COMMENT_CHARACTERS,
  GITHUB_REVIEW_MAX_COMMENTS,
} from '@project-x/types';

import { activeDraftComments, buildAggregatedReviewBody } from './draft-builders';

export type DraftValidationResult = { ok: true } | { ok: false; message: string };

export function validateReviewDraft(draft: GitHubReviewDraft): DraftValidationResult {
  if (draft.staleNavigation) {
    return {
      ok: false,
      message: `This draft belongs to ${draft.destination.owner}/${draft.destination.repository}#${draft.destination.pullRequestNumber}. Navigate back to that PR or start a new draft.`,
    };
  }

  const active = activeDraftComments(draft);
  if (active.length > GITHUB_REVIEW_MAX_COMMENTS) {
    return {
      ok: false,
      message: `A review may include at most ${GITHUB_REVIEW_MAX_COMMENTS} comments.`,
    };
  }

  for (const comment of active) {
    if (!comment.body.trim()) {
      return { ok: false, message: 'Enabled comments must not be empty.' };
    }
    if (comment.body.length > GITHUB_REVIEW_MAX_COMMENT_CHARACTERS) {
      return {
        ok: false,
        message: `A comment exceeds ${GITHUB_REVIEW_MAX_COMMENT_CHARACTERS} characters.`,
      };
    }
    if (comment.mode === 'line' && comment.positionStatus === 'valid') {
      if (!comment.position?.path || comment.position.line < 1 || !comment.position.side) {
        return {
          ok: false,
          message: 'A line-level comment is missing trusted path/line/side metadata.',
        };
      }
    }
  }

  const prNotes = active
    .filter(
      (comment) => comment.mode === 'pr' || comment.positionStatus !== 'valid' || !comment.position,
    )
    .map((comment) => ({ filePath: comment.filePath, body: comment.body }));

  const finalBody = buildAggregatedReviewBody(draft.body, prNotes);
  if (finalBody.length > GITHUB_REVIEW_MAX_BODY_CHARACTERS) {
    return {
      ok: false,
      message: `Review body exceeds ${GITHUB_REVIEW_MAX_BODY_CHARACTERS} characters.`,
    };
  }

  const hasContent =
    finalBody.trim().length > 0 ||
    active.some((c) => c.mode === 'line' && c.positionStatus === 'valid');

  if (draft.event === 'COMMENT' && !hasContent) {
    return {
      ok: false,
      message: 'COMMENT reviews require an overall body or at least one comment.',
    };
  }
  if (draft.event === 'REQUEST_CHANGES' && !hasContent) {
    return {
      ok: false,
      message: 'REQUEST_CHANGES requires review feedback (body or comments).',
    };
  }

  return { ok: true };
}

async function sha256Hex(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function createClientRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `rev-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Build immutable submission snapshot from the current draft.
 */
export async function createReviewSubmissionSnapshot(
  draft: GitHubReviewDraft,
  clientRequestId: string,
): Promise<GitHubReviewSubmissionSnapshot> {
  const validation = validateReviewDraft(draft);
  if (!validation.ok) {
    throw new Error(validation.message);
  }

  const active = activeDraftComments(draft);
  const inline = active.filter(
    (comment) => comment.mode === 'line' && comment.positionStatus === 'valid' && comment.position,
  );
  const prNotes = active
    .filter((comment) => !inline.includes(comment))
    .map((comment) => ({ filePath: comment.filePath, body: comment.body }));

  const body = buildAggregatedReviewBody(draft.body, prNotes);
  const comments = inline.map((comment) => ({
    body: comment.body.trim(),
    path: comment.position!.path,
    line: comment.position!.line,
    side: comment.position!.side,
    startLine: comment.position!.startLine,
    startSide: comment.position!.startSide,
  }));

  const fingerprintPayload = JSON.stringify({
    owner: draft.destination.owner.trim().toLowerCase(),
    repository: draft.destination.repository.trim().toLowerCase(),
    pullRequestNumber: draft.destination.pullRequestNumber,
    event: draft.event,
    body: body.trim(),
    comments: comments.map((comment) => ({
      body: comment.body,
      path: comment.path ?? null,
      line: comment.line ?? null,
      side: comment.side ?? null,
      startLine: comment.startLine ?? null,
      startSide: comment.startSide ?? null,
    })),
  });

  const fingerprint = await sha256Hex(fingerprintPayload);

  return {
    clientRequestId,
    owner: draft.destination.owner,
    repository: draft.destination.repository,
    pullRequestNumber: draft.destination.pullRequestNumber,
    event: draft.event,
    body,
    comments,
    expectedHeadSha: draft.expectedHeadSha,
    fingerprint,
    createdAt: new Date().toISOString(),
  };
}

export function snapshotToSubmitRequest(
  snapshot: GitHubReviewSubmissionSnapshot,
): SubmitPullRequestReviewRequest {
  return {
    event: snapshot.event,
    body: snapshot.body || undefined,
    comments: snapshot.comments,
    clientRequestId: snapshot.clientRequestId,
    expectedHeadSha: snapshot.expectedHeadSha,
  };
}

export function reviewEventCtaLabel(event: GitHubReviewEvent): string {
  switch (event) {
    case 'APPROVE':
      return 'Submit Approval';
    case 'REQUEST_CHANGES':
      return 'Submit Request Changes Review';
    case 'COMMENT':
    default:
      return 'Submit Review';
  }
}
