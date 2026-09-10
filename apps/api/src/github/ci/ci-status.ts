import type {
  CICheckConclusion,
  CICheckCounts,
  CICheckRunStatus,
  CINormalizedCheck,
  CIOverallStatus,
} from '@project-x/types';

export function normalizeCheckRunStatus(raw: string | null | undefined): CICheckRunStatus {
  switch ((raw ?? '').toLowerCase()) {
    case 'queued':
      return 'QUEUED';
    case 'in_progress':
      return 'IN_PROGRESS';
    case 'completed':
      return 'COMPLETED';
    case 'waiting':
    case 'requested':
    case 'pending':
      return 'WAITING';
    default:
      return 'UNKNOWN';
  }
}

export function normalizeCheckConclusion(raw: string | null | undefined): CICheckConclusion {
  if (raw == null || raw === '') {
    return null;
  }
  switch (raw.toLowerCase()) {
    case 'success':
      return 'SUCCESS';
    case 'failure':
      return 'FAILURE';
    case 'cancelled':
    case 'canceled':
      return 'CANCELLED';
    case 'skipped':
      return 'SKIPPED';
    case 'neutral':
      return 'NEUTRAL';
    case 'timed_out':
      return 'TIMED_OUT';
    case 'action_required':
      return 'ACTION_REQUIRED';
    case 'stale':
      return 'STALE';
    default:
      return 'UNKNOWN';
  }
}

/** Map legacy commit status state → check-like status/conclusion. */
export function normalizeCommitStatusState(raw: string | null | undefined): {
  status: CICheckRunStatus;
  conclusion: CICheckConclusion;
} {
  switch ((raw ?? '').toLowerCase()) {
    case 'success':
      return { status: 'COMPLETED', conclusion: 'SUCCESS' };
    case 'failure':
    case 'error':
      return { status: 'COMPLETED', conclusion: 'FAILURE' };
    case 'pending':
      return { status: 'IN_PROGRESS', conclusion: null };
    default:
      return { status: 'UNKNOWN', conclusion: 'UNKNOWN' };
  }
}

export function isFailedConclusion(conclusion: CICheckConclusion): boolean {
  return conclusion === 'FAILURE' || conclusion === 'TIMED_OUT' || conclusion === 'ACTION_REQUIRED';
}

export function isPendingCheck(check: Pick<CINormalizedCheck, 'status' | 'conclusion'>): boolean {
  if (check.status === 'QUEUED' || check.status === 'IN_PROGRESS' || check.status === 'WAITING') {
    return true;
  }
  return check.status !== 'COMPLETED' && check.conclusion == null;
}

export function computeCheckCounts(checks: CINormalizedCheck[]): CICheckCounts {
  const counts: CICheckCounts = {
    total: checks.length,
    passed: 0,
    failed: 0,
    pending: 0,
    cancelled: 0,
    neutral: 0,
    skipped: 0,
  };

  for (const check of checks) {
    if (isPendingCheck(check)) {
      counts.pending += 1;
      continue;
    }
    if (isFailedConclusion(check.conclusion)) {
      counts.failed += 1;
      continue;
    }
    switch (check.conclusion) {
      case 'SUCCESS':
        counts.passed += 1;
        break;
      case 'CANCELLED':
        counts.cancelled += 1;
        break;
      case 'NEUTRAL':
      case 'STALE':
        counts.neutral += 1;
        break;
      case 'SKIPPED':
        counts.skipped += 1;
        break;
      default:
        counts.neutral += 1;
        break;
    }
  }

  return counts;
}

export function computeOverallStatus(checks: CINormalizedCheck[]): CIOverallStatus {
  if (checks.length === 0) {
    return 'UNKNOWN';
  }

  const counts = computeCheckCounts(checks);
  if (counts.failed > 0) {
    return 'FAILURE';
  }
  if (counts.pending > 0) {
    return 'PENDING';
  }
  if (counts.cancelled > 0 && counts.passed === 0 && counts.neutral === 0 && counts.skipped === 0) {
    return 'CANCELLED';
  }
  if (counts.passed > 0) {
    return 'SUCCESS';
  }
  if (counts.skipped === counts.total) {
    return 'SKIPPED';
  }
  if (counts.neutral === counts.total) {
    return 'NEUTRAL';
  }
  if (counts.cancelled > 0) {
    return 'CANCELLED';
  }
  return 'UNKNOWN';
}

export function formatCheckRunId(id: number): string {
  return `check_run:${id}`;
}

export function formatStatusId(context: string): string {
  return `status:${encodeURIComponent(context)}`;
}

export function parseCheckProviderId(
  id: string,
): { kind: 'check_run'; runId: number } | { kind: 'status'; context: string } | null {
  if (id.startsWith('check_run:')) {
    const runId = Number.parseInt(id.slice('check_run:'.length), 10);
    if (!Number.isFinite(runId) || runId < 1) {
      return null;
    }
    return { kind: 'check_run', runId };
  }
  if (id.startsWith('status:')) {
    try {
      return { kind: 'status', context: decodeURIComponent(id.slice('status:'.length)) };
    } catch {
      return null;
    }
  }
  return null;
}
