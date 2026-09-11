import { describe, expect, it } from 'vitest';
import type { WorkflowContextBinding } from '@project-x/types';

import { isWorkflowBindingStale } from './stale';

const base: WorkflowContextBinding = {
  jira: { issueKey: 'PAY-321', updatedAt: '2026-09-11T10:00:00.000Z' },
  github: {
    repository: 'acme/pay',
    prNumber: 142,
    headSha: 'abc1234',
  },
  api: {
    documentHash: 'hash-1',
    operationKey: 'POST /payments/{id}/retry',
  },
  ci: {
    headSha: 'abc1234',
    checkIds: ['check_run:1'],
  },
};

describe('isWorkflowBindingStale', () => {
  it('detects PR head change only', () => {
    const current: WorkflowContextBinding = {
      ...base,
      github: { ...base.github!, headSha: 'def5678' },
    };
    const result = isWorkflowBindingStale(base, current);
    expect(result.stale).toBe(true);
    expect(result.changed).toEqual(['github']);
  });

  it('detects Jira change only', () => {
    const current: WorkflowContextBinding = {
      ...base,
      jira: { issueKey: 'PAY-321', updatedAt: '2026-09-11T11:00:00.000Z' },
    };
    const result = isWorkflowBindingStale(base, current);
    expect(result.stale).toBe(true);
    expect(result.changed).toEqual(['jira']);
  });

  it('detects API change only', () => {
    const current: WorkflowContextBinding = {
      ...base,
      api: { documentHash: 'hash-2', operationKey: 'POST /payments/{id}/retry' },
    };
    const result = isWorkflowBindingStale(base, current);
    expect(result.stale).toBe(true);
    expect(result.changed).toEqual(['api']);
  });

  it('detects CI change', () => {
    const current: WorkflowContextBinding = {
      ...base,
      ci: { headSha: 'abc1234', checkIds: ['check_run:2'] },
    };
    const result = isWorkflowBindingStale(base, current);
    expect(result.stale).toBe(true);
    expect(result.changed).toEqual(['ci']);
  });

  it('is not stale when bindings match', () => {
    expect(isWorkflowBindingStale(base, { ...base })).toEqual({
      stale: false,
      changed: [],
    });
  });
});
