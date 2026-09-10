import { describe, expect, it } from 'vitest';
import {
  computeCheckCounts,
  computeOverallStatus,
  formatCheckRunId,
  isFailedConclusion,
  normalizeCheckConclusion,
  normalizeCheckRunStatus,
  normalizeCommitStatusState,
  parseCheckProviderId,
} from './ci-status';
import type { CINormalizedCheck } from '@project-x/types';

function check(
  partial: Partial<CINormalizedCheck> & Pick<CINormalizedCheck, 'id' | 'name'>,
): CINormalizedCheck {
  return {
    status: 'COMPLETED',
    conclusion: 'SUCCESS',
    canInspectDetails: false,
    evidenceCapabilities: ['STATUS_ONLY'],
    ...partial,
  };
}

describe('ci-status', () => {
  it('normalizes check run statuses and conclusions', () => {
    expect(normalizeCheckRunStatus('in_progress')).toBe('IN_PROGRESS');
    expect(normalizeCheckRunStatus('queued')).toBe('QUEUED');
    expect(normalizeCheckConclusion('failure')).toBe('FAILURE');
    expect(normalizeCheckConclusion('canceled')).toBe('CANCELLED');
    expect(normalizeCheckConclusion(null)).toBeNull();
    expect(normalizeCheckConclusion('weird')).toBe('UNKNOWN');
  });

  it('normalizes legacy commit status states', () => {
    expect(normalizeCommitStatusState('pending')).toEqual({
      status: 'IN_PROGRESS',
      conclusion: null,
    });
    expect(normalizeCommitStatusState('error')).toEqual({
      status: 'COMPLETED',
      conclusion: 'FAILURE',
    });
  });

  it('computes mixed overall status', () => {
    const checks = [
      check({ id: '1', name: 'a', conclusion: 'SUCCESS' }),
      check({ id: '2', name: 'b', conclusion: 'FAILURE' }),
      check({ id: '3', name: 'c', status: 'IN_PROGRESS', conclusion: null }),
    ];
    expect(computeOverallStatus(checks)).toBe('FAILURE');
    expect(computeCheckCounts(checks)).toMatchObject({
      passed: 1,
      failed: 1,
      pending: 1,
      total: 3,
    });
  });

  it('treats pending as overall PENDING when nothing failed', () => {
    const checks = [
      check({ id: '1', name: 'a', conclusion: 'SUCCESS' }),
      check({ id: '2', name: 'b', status: 'QUEUED', conclusion: null }),
    ];
    expect(computeOverallStatus(checks)).toBe('PENDING');
  });

  it('handles cancelled / neutral / skipped / empty', () => {
    expect(computeOverallStatus([])).toBe('UNKNOWN');
    expect(computeOverallStatus([check({ id: '1', name: 'a', conclusion: 'CANCELLED' })])).toBe(
      'CANCELLED',
    );
    expect(computeOverallStatus([check({ id: '1', name: 'a', conclusion: 'NEUTRAL' })])).toBe(
      'NEUTRAL',
    );
    expect(computeOverallStatus([check({ id: '1', name: 'a', conclusion: 'SKIPPED' })])).toBe(
      'SKIPPED',
    );
  });

  it('parses provider ids', () => {
    expect(formatCheckRunId(42)).toBe('check_run:42');
    expect(parseCheckProviderId('check_run:42')).toEqual({ kind: 'check_run', runId: 42 });
    expect(parseCheckProviderId('status:ci%2Fjenkins')).toEqual({
      kind: 'status',
      context: 'ci/jenkins',
    });
    expect(parseCheckProviderId('nope')).toBeNull();
  });

  it('detects failed conclusions', () => {
    expect(isFailedConclusion('FAILURE')).toBe(true);
    expect(isFailedConclusion('TIMED_OUT')).toBe(true);
    expect(isFailedConclusion('SUCCESS')).toBe(false);
  });
});
