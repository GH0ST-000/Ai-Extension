import { describe, expect, it } from 'vitest';
import type { WorkflowContextBinding } from '@project-x/types';

import { detectWorkflowContextChanges } from './context-change';

const planned: WorkflowContextBinding = {
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

describe('detectWorkflowContextChanges', () => {
  it('detects HEAD_CHANGED', () => {
    const current: WorkflowContextBinding = {
      ...planned,
      github: { ...planned.github!, headSha: 'def5678' },
    };
    expect(detectWorkflowContextChanges(planned, current)).toEqual([
      {
        source: 'github',
        kind: 'HEAD_CHANGED',
        previous: 'abc1234',
        current: 'def5678',
      },
    ]);
  });

  it('detects ISSUE_UPDATED', () => {
    const current: WorkflowContextBinding = {
      ...planned,
      jira: { issueKey: 'PAY-321', updatedAt: '2026-09-11T12:00:00.000Z' },
    };
    expect(detectWorkflowContextChanges(planned, current)).toEqual([
      { source: 'jira', kind: 'ISSUE_UPDATED' },
    ]);
  });

  it('detects DOCUMENT_CHANGED', () => {
    const current: WorkflowContextBinding = {
      ...planned,
      api: { documentHash: 'hash-2', operationKey: 'POST /payments/{id}/retry' },
    };
    expect(detectWorkflowContextChanges(planned, current)).toEqual([
      { source: 'api', kind: 'DOCUMENT_CHANGED' },
    ]);
  });

  it('detects CHECK_STATE_CHANGED', () => {
    const current: WorkflowContextBinding = {
      ...planned,
      ci: { headSha: 'zzzzzzz', checkIds: ['check_run:1'] },
    };
    expect(detectWorkflowContextChanges(planned, current)).toEqual([
      { source: 'ci', kind: 'CHECK_STATE_CHANGED' },
    ]);
  });

  it('returns no changes when bindings match', () => {
    expect(detectWorkflowContextChanges(planned, { ...planned })).toEqual([]);
  });
});
