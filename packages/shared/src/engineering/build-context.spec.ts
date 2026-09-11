import { describe, expect, it } from 'vitest';
import type { EngineeringContextBuildInput } from '@project-x/types';
import { ENGINEERING_MAX_DIFF_CHARS, ENGINEERING_MAX_PR_FILES } from '@project-x/types';

import { buildEngineeringContext } from './build-context';

const baseJira: NonNullable<EngineeringContextBuildInput['jira']> = {
  issueKey: 'PAY-321',
  siteHost: 'acme.atlassian.net',
  updatedAt: '2026-09-11T10:00:00.000Z',
  summary: 'Retry payment safely',
  descriptionPlainText: `
Acceptance Criteria:
- Duplicate retries must not create multiple charges
- Return 409 when already processing
`,
};

const baseGithub: NonNullable<EngineeringContextBuildInput['github']> = {
  repository: { owner: 'acme', name: 'pay' },
  pullRequestNumber: 142,
  headSha: 'abc1234',
  title: 'PAY-321 retry idempotency',
  changedFiles: [
    { path: 'src/payment.service.ts', patch: '+ idempotency guard\n' },
    { path: 'src/retry.controller.ts', patch: '+ retry endpoint\n' },
    { path: 'README.md', patch: '+ docs\n' },
  ],
};

const baseApi: NonNullable<EngineeringContextBuildInput['api']> = {
  documentHash: 'hash-openapi-1',
  title: 'Payments API',
  operation: {
    method: 'POST',
    path: '/payments/{id}/retry',
    operationId: 'retryPayment',
  },
  contextText: 'POST /payments/{id}/retry returns 200/400',
};

describe('buildEngineeringContext', () => {
  it('builds from two sources (jira + github)', () => {
    const result = buildEngineeringContext({
      jira: baseJira,
      github: baseGithub,
      createdAt: '2026-09-11T12:00:00.000Z',
    });
    expect('error' in result).toBe(false);
    if ('error' in result) return;

    expect(result.jira?.issueKey).toBe('PAY-321');
    expect(result.jira?.explicitAcceptanceCriteria.length).toBeGreaterThanOrEqual(2);
    expect(result.github?.pullRequestNumber).toBe(142);
    expect(result.scope.includedSources).toContain('jira');
    expect(result.scope.includedSources).toContain('github-pr');
    expect(result.id).toMatch(/^eng-[0-9a-f]{8}$/);
  });

  it('builds from three sources', () => {
    const result = buildEngineeringContext({
      jira: baseJira,
      github: baseGithub,
      api: baseApi,
      createdAt: '2026-09-11T12:00:00.000Z',
    });
    expect('error' in result).toBe(false);
    if ('error' in result) return;

    expect(result.api?.operation?.path).toBe('/payments/{id}/retry');
    expect(result.scope.includedSources).toEqual(
      expect.arrayContaining(['jira', 'github-pr', 'openapi']),
    );
  });

  it('returns INSUFFICIENT with fewer than two primary sources', () => {
    const result = buildEngineeringContext({ jira: baseJira });
    expect(result).toEqual({
      error: 'ENGINEERING_CONTEXT_INSUFFICIENT',
      message: 'Select at least two related engineering contexts to compare.',
    });
  });

  it('omits CI when headSha does not match github headSha', () => {
    const result = buildEngineeringContext({
      jira: baseJira,
      github: baseGithub,
      ci: {
        headSha: 'different-sha',
        status: 'FAILURE',
        failedChecks: [{ name: 'unit-tests', conclusion: 'FAILURE' }],
      },
      createdAt: '2026-09-11T12:00:00.000Z',
    });
    expect('error' in result).toBe(false);
    if ('error' in result) return;

    expect(result.ci).toBeUndefined();
    expect(result.scope.includedSources).not.toContain('ci');
    expect(result.scope.truncationReasons).toContain('ci-omitted-head-sha-mismatch');
    expect(result.scope.partial).toBe(true);
  });

  it('includes CI when headSha matches', () => {
    const result = buildEngineeringContext({
      github: baseGithub,
      api: baseApi,
      ci: {
        headSha: 'abc1234',
        status: 'FAILURE',
        failedChecks: [{ name: 'unit-tests', conclusion: 'FAILURE' }],
        summaryText: 'test failed',
      },
      createdAt: '2026-09-11T12:00:00.000Z',
    });
    expect('error' in result).toBe(false);
    if ('error' in result) return;

    expect(result.ci?.headSha).toBe('abc1234');
    expect(result.scope.includedSources).toContain('ci');
  });

  it('applies PR file and diff budgets with relevance prioritization', () => {
    const manyFiles = Array.from({ length: ENGINEERING_MAX_PR_FILES + 6 }, (_, i) => ({
      path: i < 3 ? `src/payment/retry-${i}.ts` : `docs/unrelated-${i}.md`,
      patch: `+ change ${i}\n${'x'.repeat(800)}`,
    }));

    const result = buildEngineeringContext({
      jira: baseJira,
      github: { ...baseGithub, changedFiles: manyFiles },
      api: baseApi,
      createdAt: '2026-09-11T12:00:00.000Z',
    });
    expect('error' in result).toBe(false);
    if ('error' in result) return;

    expect(result.github?.changedFiles.length).toBeLessThanOrEqual(ENGINEERING_MAX_PR_FILES);
    expect(result.scope.partial).toBe(true);
    expect(result.scope.truncationReasons.some((r) => r.startsWith('pr-files-capped'))).toBe(true);

    const totalDiff = (result.github?.changedFiles ?? []).reduce(
      (sum, f) => sum + (f.patchExcerpt?.length ?? 0),
      0,
    );
    expect(totalDiff).toBeLessThanOrEqual(ENGINEERING_MAX_DIFF_CHARS);

    // Relevant retry/payment files should sort ahead of unrelated docs
    const paths = result.github?.changedFiles.map((f) => f.path) ?? [];
    expect(paths.some((p) => p.includes('retry'))).toBe(true);
    const firstUnrelatedIdx = paths.findIndex((p) => p.includes('unrelated'));
    const lastRelevantIdx = Math.max(
      ...paths.map((p, i) => (p.includes('retry') || p.includes('payment') ? i : -1)),
    );
    if (firstUnrelatedIdx >= 0 && lastRelevantIdx >= 0) {
      expect(lastRelevantIdx).toBeLessThan(firstUnrelatedIdx);
    }
  });
});
