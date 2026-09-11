import { describe, expect, it } from 'vitest';
import type { EngineeringContext, EngineeringEvidence } from '@project-x/types';

import { validateEngineeringEvidence } from './evidence';

const ctx: EngineeringContext = {
  id: 'eng-test',
  createdAt: '2026-09-11T12:00:00.000Z',
  jira: {
    issueKey: 'PAY-321',
    siteHost: 'acme.atlassian.net',
    summary: 'Retry',
    explicitAcceptanceCriteria: [{ id: 'ac-1', text: 'Must be idempotent', source: 'description' }],
  },
  github: {
    repository: { owner: 'acme', name: 'pay' },
    pullRequestNumber: 142,
    headSha: 'abc1234',
    changedFiles: [{ path: 'src/payment.service.ts', relevance: 'high' }],
  },
  api: {
    documentHash: 'hash-1',
    operation: {
      method: 'POST',
      path: '/payments/{id}/retry',
      operationId: 'retryPayment',
    },
  },
  scope: {
    partial: false,
    truncationReasons: [],
    includedSources: ['jira', 'github-pr', 'openapi'],
  },
};

describe('validateEngineeringEvidence', () => {
  it('rejects path traversal', () => {
    const evidence: EngineeringEvidence = {
      source: 'github-diff',
      label: 'secret',
      reference: { filePath: '../../secret' },
    };
    expect(validateEngineeringEvidence(evidence, ctx)).toBeNull();
  });

  it('rejects unknown file paths', () => {
    const evidence: EngineeringEvidence = {
      source: 'github-diff',
      label: 'other',
      reference: { filePath: 'src/other.ts' },
    };
    expect(validateEngineeringEvidence(evidence, ctx)).toBeNull();
  });

  it('accepts a known file path', () => {
    const evidence: EngineeringEvidence = {
      source: 'github-diff',
      label: 'idempotency guard',
      reference: { filePath: 'src/payment.service.ts' },
      excerpt: 'added lock',
    };
    const validated = validateEngineeringEvidence(evidence, ctx);
    expect(validated).not.toBeNull();
    expect(validated?.reference?.filePath).toBe('src/payment.service.ts');
  });

  it('rejects unknown criterion ids', () => {
    const evidence: EngineeringEvidence = {
      source: 'jira',
      label: 'criterion',
      reference: { criterionId: 'ac-99' },
    };
    expect(validateEngineeringEvidence(evidence, ctx)).toBeNull();
  });

  it('rejects unknown operations', () => {
    const evidence: EngineeringEvidence = {
      source: 'openapi',
      label: 'op',
      reference: { operationId: 'otherOp' },
    };
    expect(validateEngineeringEvidence(evidence, ctx)).toBeNull();
  });
});
