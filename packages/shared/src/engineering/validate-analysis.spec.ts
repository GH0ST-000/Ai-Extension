import { describe, expect, it } from 'vitest';
import type { AnalysisBinding, EngineeringContext } from '@project-x/types';

import { validateEngineeringAlignmentAnalysis } from './validate-analysis';

function minimalContext(): EngineeringContext {
  return {
    id: 'ctx1',
    createdAt: '2026-09-11T00:00:00.000Z',
    jira: {
      siteHost: 'acme.atlassian.net',
      issueKey: 'PAY-1',
      updatedAt: '2026-09-11T00:00:00.000Z',
      summary: 'Retry payments',
      explicitAcceptanceCriteria: [
        { id: 'ac-1', text: 'Return 409 when already processing', source: 'description' },
      ],
    },
    github: {
      repository: { owner: 'acme', name: 'payments' },
      pullRequestNumber: 42,
      headSha: 'abc1234deadbeef',
      changedFiles: [{ path: 'src/retry.ts', patchExcerpt: '+return 409', relevance: 'high' }],
    },
    api: {
      documentHash: 'hashhashhash',
      title: 'Payments',
      operation: { method: 'POST', path: '/payments/{id}/retry', operationId: 'retryPayment' },
    },
    scope: {
      partial: false,
      truncationReasons: [],
      includedSources: ['jira', 'github-pr', 'openapi'],
    },
  };
}

const binding: AnalysisBinding = {
  jira: { issueKey: 'PAY-1', updatedAt: '2026-09-11T00:00:00.000Z' },
  github: { repository: 'acme/payments', prNumber: 42, headSha: 'abc1234deadbeef' },
  api: { documentHash: 'hashhashhash', operationKey: 'POST:/payments/{id}/retry' },
};

describe('validateEngineeringAlignmentAnalysis', () => {
  it('accepts grounded coverage and drops hallucinated file evidence', () => {
    const raw = {
      overview: 'Partial alignment.',
      alignment: 'partial',
      requirementCoverage: [
        {
          criterionId: 'ac-1',
          criterion: 'Return 409 when already processing',
          criterionSource: 'description',
          status: 'conflicting',
          confidence: 'high',
          evidence: [
            {
              source: 'github-diff',
              label: 'retry handler',
              reference: { filePath: 'src/retry.ts' },
              excerpt: 'return 409',
            },
            {
              source: 'github-diff',
              label: 'hallucinated',
              reference: { filePath: '../../secret.env' },
            },
          ],
        },
      ],
      implementationObservations: [],
      contractAlignment: [],
      crossContextConflicts: [],
      risks: [],
      openQuestions: ['Is 409 documented?'],
      scope: { partial: false, limitations: [] },
    };

    const result = validateEngineeringAlignmentAnalysis(raw, minimalContext(), binding);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.analysis.requirementCoverage[0]?.evidence).toHaveLength(1);
    expect(result.analysis.requirementCoverage[0]?.evidence[0]?.reference?.filePath).toBe(
      'src/retry.ts',
    );
  });

  it('rejects invalid alignment payload', () => {
    const result = validateEngineeringAlignmentAnalysis(
      { overview: 'x' },
      minimalContext(),
      binding,
    );
    expect(result.ok).toBe(false);
  });
});
