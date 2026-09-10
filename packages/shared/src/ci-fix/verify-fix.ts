import type {
  CIFixVerification,
  CIFixVerificationStatus,
  CINormalizedCheck,
  PullRequestCISummary,
} from '@project-x/types';

import { compareFailureSignatures } from './failure-signature';

function isFailedConclusion(check: CINormalizedCheck): boolean {
  return (
    check.conclusion === 'FAILURE' ||
    check.conclusion === 'TIMED_OUT' ||
    check.conclusion === 'ACTION_REQUIRED'
  );
}

function isPendingCheck(check: CINormalizedCheck): boolean {
  return (
    check.status === 'QUEUED' ||
    check.status === 'IN_PROGRESS' ||
    check.status === 'WAITING' ||
    (check.status !== 'COMPLETED' && check.conclusion == null)
  );
}

/**
 * Correlate a source check to a check on the new head.
 * Prefer exact id (rare across heads), then exact name (case-insensitive).
 * No fuzzy / LLM matching.
 */
export function matchCheckOnNewHead(
  summary: PullRequestCISummary,
  original: { id: string; name: string },
): CINormalizedCheck | null {
  const byId = summary.checks.find((c) => c.id === original.id);
  if (byId) {
    return byId;
  }
  const name = original.name.trim().toLowerCase();
  const nameMatches = summary.checks.filter((c) => c.name.trim().toLowerCase() === name);
  if (nameMatches.length === 1) {
    return nameMatches[0] ?? null;
  }
  return null;
}

export type VerifyCIFixInput = {
  originalCheckId: string;
  originalCheckName: string;
  originalHeadSha: string;
  newHeadSha: string;
  summary: PullRequestCISummary;
  previousFailureSignature?: string;
  currentFailureSignature?: string;
};

/**
 * Deterministic verification from GitHub CI facts for the new head only.
 * AI must never set verification status.
 */
export function verifyCIFixAgainstSummary(input: VerifyCIFixInput): CIFixVerification {
  const comparedAt = new Date().toISOString();

  if (input.summary.headSha !== input.newHeadSha) {
    return {
      originalCheckId: input.originalCheckId,
      originalCheckName: input.originalCheckName,
      originalHeadSha: input.originalHeadSha,
      newHeadSha: input.newHeadSha,
      status: 'UNKNOWN',
      comparedAt,
      previousFailureSignature: input.previousFailureSignature,
      currentFailureSignature: input.currentFailureSignature,
      overallStatus: input.summary.overallStatus,
    };
  }

  const matched = matchCheckOnNewHead(input.summary, {
    id: input.originalCheckId,
    name: input.originalCheckName,
  });

  if (!matched) {
    // No equivalent check yet — waiting, not success
    if (input.summary.overallStatus === 'PENDING' || input.summary.checks.length === 0) {
      return {
        originalCheckId: input.originalCheckId,
        originalCheckName: input.originalCheckName,
        originalHeadSha: input.originalHeadSha,
        newHeadSha: input.newHeadSha,
        status: 'PENDING',
        comparedAt,
        previousFailureSignature: input.previousFailureSignature,
        overallStatus: input.summary.overallStatus,
      };
    }
    return {
      originalCheckId: input.originalCheckId,
      originalCheckName: input.originalCheckName,
      originalHeadSha: input.originalHeadSha,
      newHeadSha: input.newHeadSha,
      status: 'CHECK_NOT_FOUND',
      comparedAt,
      previousFailureSignature: input.previousFailureSignature,
      overallStatus: input.summary.overallStatus,
      otherChecksFailing: input.summary.counts.failed > 0,
    };
  }

  let status: CIFixVerificationStatus;
  if (isPendingCheck(matched)) {
    status = 'PENDING';
  } else if (matched.conclusion === 'SUCCESS') {
    status = 'PASSED';
  } else if (matched.conclusion === 'CANCELLED') {
    status = 'CANCELLED';
  } else if (matched.conclusion === 'SKIPPED') {
    status = 'SKIPPED';
  } else if (matched.conclusion === 'NEUTRAL' || matched.conclusion === 'STALE') {
    status = 'NEUTRAL';
  } else if (isFailedConclusion(matched)) {
    const cmp = compareFailureSignatures(
      input.previousFailureSignature,
      input.currentFailureSignature,
    );
    if (cmp === 'different') {
      status = 'DIFFERENT_FAILURE';
    } else if (cmp === 'same') {
      status = 'STILL_FAILING';
    } else {
      status = 'STILL_FAILING';
    }
  } else {
    status = 'UNKNOWN';
  }

  const otherChecksFailing =
    status === 'PASSED'
      ? input.summary.checks.some((c) => c.id !== matched.id && isFailedConclusion(c))
      : input.summary.counts.failed > 0;

  return {
    originalCheckId: input.originalCheckId,
    originalCheckName: input.originalCheckName,
    originalHeadSha: input.originalHeadSha,
    newHeadSha: input.newHeadSha,
    matchedCheckId: matched.id,
    matchedCheckName: matched.name,
    status,
    comparedAt,
    previousFailureSignature: input.previousFailureSignature,
    currentFailureSignature: input.currentFailureSignature,
    otherChecksFailing,
    overallStatus: input.summary.overallStatus,
  };
}

export function verificationToSessionStatus(
  status: CIFixVerificationStatus,
):
  | 'WAITING_FOR_NEW_CI'
  | 'PASSED'
  | 'STILL_FAILING'
  | 'DIFFERENT_FAILURE'
  | 'CHECK_NOT_FOUND'
  | 'VERIFYING' {
  switch (status) {
    case 'PENDING':
      return 'WAITING_FOR_NEW_CI';
    case 'PASSED':
      return 'PASSED';
    case 'STILL_FAILING':
      return 'STILL_FAILING';
    case 'DIFFERENT_FAILURE':
      return 'DIFFERENT_FAILURE';
    case 'CHECK_NOT_FOUND':
      return 'CHECK_NOT_FOUND';
    default:
      return 'VERIFYING';
  }
}
