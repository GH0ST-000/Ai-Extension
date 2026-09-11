import { describe, expect, it } from 'vitest';
import type { JiraIssue, NormalizedApiContract, PageContext } from '@project-x/types';

import {
  assembleEngineeringBuildInput,
  canAnalyzeEngineeringAlignment,
  countEngineeringSources,
  detectEngineeringSourceFlags,
  formatEngineeringBannerSummary,
  bindingFromEngineeringContext,
} from './engineering.store';
import { buildEngineeringContext } from '@project-x/shared';

function makeJira(overrides?: Partial<JiraIssue>): JiraIssue {
  return {
    id: '1',
    key: 'PAY-321',
    project: { key: 'PAY' },
    summary: 'Retry payment',
    siteHost: 'acme.atlassian.net',
    fetchedAt: '2026-01-01T00:00:00.000Z',
    description: {
      plainText: 'Acceptance Criteria:\n- Must retry once\n- Must log failure',
      truncated: false,
    },
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

function makeGithubPage(): PageContext {
  return {
    type: 'github',
    url: 'https://github.com/acme/api/pull/142',
    title: 'PR',
    github: {
      owner: 'acme',
      repository: 'api',
      pullRequestNumber: 142,
      pullRequestTitle: 'Retry payments',
      headBranch: 'feat/retry',
      changedFiles: [{ path: 'src/payments/retry.ts', patchExcerpt: '+retry()' }],
    },
  };
}

function makeContract(): NormalizedApiContract {
  return {
    documentHash: 'hash-abc',
    title: 'Payments API',
    version: '1.0.0',
    source: { type: 'page' },
    servers: [],
    tags: [],
    schemas: {},
    operations: [
      {
        id: 'op-1',
        method: 'POST',
        path: '/payments/{id}/retry',
        operationId: 'retryPayment',
        summary: 'Retry a payment',
        parameters: [],
        responses: [],
      },
    ],
    fetchedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('engineering source helpers', () => {
  it('requires at least two primary sources to analyze', () => {
    expect(
      canAnalyzeEngineeringAlignment({ jira: true, github: false, api: false, ci: false }),
    ).toBe(false);
    expect(
      canAnalyzeEngineeringAlignment({ jira: true, github: true, api: false, ci: false }),
    ).toBe(true);
    expect(countEngineeringSources({ jira: true, github: true, api: true, ci: true })).toBe(3);
  });

  it('detects jira + github + api sources', () => {
    const flags = detectEngineeringSourceFlags({
      jiraIssue: makeJira(),
      pageSnapshot: makeGithubPage(),
      openApiContract: makeContract(),
      openApiOperation: makeContract().operations[0]!,
    });
    expect(flags).toEqual({ jira: true, github: true, api: true, ci: false });
  });

  it('formats banner summary from built context', () => {
    const result = buildEngineeringContext(
      assembleEngineeringBuildInput({
        jiraIssue: makeJira(),
        pageSnapshot: makeGithubPage(),
        openApiContract: makeContract(),
        openApiOperation: makeContract().operations[0]!,
      }),
    );
    expect('error' in result).toBe(false);
    if ('error' in result) {
      return;
    }
    expect(formatEngineeringBannerSummary(result)).toContain('PAY-321');
    expect(formatEngineeringBannerSummary(result)).toContain('PR #142');
    expect(formatEngineeringBannerSummary(result)).toContain('POST /payments/{id}/retry');
    const binding = bindingFromEngineeringContext(result);
    expect(binding.jira?.issueKey).toBe('PAY-321');
    expect(binding.github?.prNumber).toBe(142);
    expect(binding.api?.documentHash).toBe('hash-abc');
  });

  it('returns insufficient when only one source is present', () => {
    const result = buildEngineeringContext(
      assembleEngineeringBuildInput({
        jiraIssue: makeJira(),
      }),
    );
    expect(result).toMatchObject({ error: 'ENGINEERING_CONTEXT_INSUFFICIENT' });
  });
});
