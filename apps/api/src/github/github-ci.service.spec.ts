import { HttpException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GithubCiService } from './github-ci.service';
import { GithubErrorNormalizer } from './github-error-normalizer';
import { workspaceException } from '../workspaces/workspace.errors';

describe('GithubCiService', () => {
  const errors = new GithubErrorNormalizer();
  const githubConnections = {
    getDecryptedToken: vi.fn(),
  };
  const aiService = {
    generateAction: vi.fn(),
    generateActionWithMetadata: vi.fn(),
  };

  let service: GithubCiService;
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    githubConnections.getDecryptedToken.mockResolvedValue('token');
    service = new GithubCiService(githubConnections as never, errors, aiService as never);
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function mockFetchSequence(handlers: Array<(url: string) => Promise<Response> | Response>): void {
    let i = 0;
    global.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const handler = handlers[i];
      i += 1;
      if (!handler) {
        throw new Error(`Unexpected fetch: ${url}`);
      }
      return handler(url);
    }) as typeof fetch;
  }

  it('lists checks bound to trusted PR head SHA', async () => {
    mockFetchSequence([
      () =>
        Response.json({
          number: 12,
          head: { sha: 'abc123deadbeef' },
        }),
      () =>
        Response.json({
          check_runs: [
            {
              id: 1,
              name: 'unit-tests',
              status: 'completed',
              conclusion: 'failure',
              app: { name: 'GitHub Actions' },
              html_url: 'https://github.com/acme/pay/actions/runs/1/job/1',
            },
            {
              id: 2,
              name: 'build',
              status: 'completed',
              conclusion: 'success',
            },
          ],
        }),
      () => Response.json({ statuses: [] }),
    ]);

    const summary = await service.listPullRequestChecks('user-1', 'acme', 'pay', 12);
    expect(summary.headSha).toBe('abc123deadbeef');
    expect(summary.overallStatus).toBe('FAILURE');
    expect(summary.counts.failed).toBe(1);
    expect(summary.counts.passed).toBe(1);
    expect(summary.checks[0]?.id).toBe('check_run:1');
  });

  it('requires GitHub connection', async () => {
    githubConnections.getDecryptedToken.mockResolvedValue(null);
    await expect(service.listPullRequestChecks('user-1', 'acme', 'pay', 12)).rejects.toBeInstanceOf(
      HttpException,
    );
    try {
      await service.listPullRequestChecks('user-1', 'acme', 'pay', 12);
    } catch (error) {
      expect((error as HttpException).getResponse()).toMatchObject({ code: 'NOT_CONNECTED' });
    }
  });

  it('normalizes third-party status without fabricating logs', async () => {
    mockFetchSequence([
      () => Response.json({ number: 1, head: { sha: 'sha1' } }),
      () => Response.json({ check_runs: [] }),
      () =>
        Response.json({
          statuses: [
            {
              context: 'ci/circleci',
              state: 'failure',
              description: 'Build failed',
              target_url: 'https://circleci.com/gh/acme/pay/1',
            },
          ],
        }),
    ]);

    const summary = await service.listPullRequestChecks('u', 'acme', 'pay', 1);
    expect(summary.checks).toHaveLength(1);
    expect(summary.checks[0]?.evidenceCapabilities).toContain('EXTERNAL_LINK');

    mockFetchSequence([
      () => Response.json({ number: 1, head: { sha: 'sha1' } }),
      () =>
        Response.json({
          statuses: [
            {
              context: 'ci/circleci',
              state: 'failure',
              description: 'Build failed',
              target_url: 'https://circleci.com/gh/acme/pay/1',
            },
          ],
        }),
    ]);

    const evidence = await service.getCheckFailureEvidence(
      'u',
      'acme',
      'pay',
      1,
      'status:ci%2Fcircleci',
    );
    expect(evidence.logsUnavailable).toBe(true);
    expect(evidence.logExcerpt).toBeUndefined();
    expect(evidence.summaryText).toBe('Build failed');
  });

  it('rejects stale expected head on analyze', async () => {
    mockFetchSequence([
      () => Response.json({ number: 1, head: { sha: 'newsha' } }),
      () =>
        Response.json({
          id: 9,
          name: 'unit-tests',
          status: 'completed',
          conclusion: 'failure',
          output: { summary: 'fail' },
          app: { name: 'GitHub Actions' },
        }),
      () => Response.json([]),
    ]);

    try {
      await service.analyzeCheckFailure('u', 'acme', 'pay', 1, 'check_run:9', {
        expectedHeadSha: 'oldsha',
      });
      expect.unreachable();
    } catch (error) {
      expect((error as HttpException).getResponse()).toMatchObject({ code: 'STALE_CI_CONTEXT' });
    }
  });

  it('analyzes failure with structured AI result and no auto-fix', async () => {
    mockFetchSequence([
      () => Response.json({ number: 1, head: { sha: 'headsha' }, title: 'Fix' }),
      () =>
        Response.json({
          id: 9,
          name: 'unit-tests',
          status: 'completed',
          conclusion: 'failure',
          output: { summary: 'Expected 1 call' },
          app: { name: 'GitHub Actions' },
        }),
      () =>
        Response.json([
          {
            path: 'src/a.ts',
            start_line: 10,
            annotation_level: 'failure',
            message: 'Expected 1 call',
          },
        ]),
    ]);

    // Like AiService: the caller's validator runs before the charge.
    aiService.generateActionWithMetadata.mockImplementation(
      async (_u: string, _i: unknown, opts?: { validate?: (t: string) => void }) => {
        const text = JSON.stringify({
          summary: 'Assertion failed',
          likelyRootCause: 'Double invoke',
          confidence: 'medium',
          relatedToPullRequest: 'likely',
          affectedFiles: [{ path: 'src/a.ts', reason: 'annotation' }],
          suggestedNextSteps: ['Inspect retry'],
          canSuggestFix: true,
        });
        opts?.validate?.(text);
        return { text };
      },
    );

    const result = await service.analyzeCheckFailure('u', 'acme', 'pay', 1, 'check_run:9', {
      expectedHeadSha: 'headsha',
      changedFiles: [{ path: 'src/a.ts' }],
    });

    expect(result.analysis.canSuggestFix).toBe(true);
    expect(result.analysis.headSha).toBe('headsha');
    expect(result.analysis.checkId).toBe('check_run:9');
    expect(aiService.generateActionWithMetadata).toHaveBeenCalledTimes(1);
    expect(aiService.generateActionWithMetadata.mock.calls[0]?.[1]?.action).toBe(
      'ANALYZE_CI_FAILURE',
    );
  });

  describe('AI error propagation', () => {
    const failureFetches = () =>
      mockFetchSequence([
        () => Response.json({ number: 1, head: { sha: 'headsha' }, title: 'Fix' }),
        () =>
          Response.json({
            id: 9,
            name: 'unit-tests',
            status: 'completed',
            conclusion: 'failure',
            output: { summary: 'Expected 1 call' },
            app: { name: 'GitHub Actions' },
          }),
        () => Response.json([]),
      ]);
    const analyze = () =>
      service.analyzeCheckFailure('u', 'acme', 'pay', 1, 'check_run:9', {
        expectedHeadSha: 'headsha',
        changedFiles: [{ path: 'src/a.ts' }],
      });
    const codeOf = async () => {
      try {
        await analyze();
        return 'ok';
      } catch (error) {
        return ((error as HttpException).getResponse() as { code?: string }).code;
      }
    };

    it.each(['USAGE_LIMIT_REACHED', 'FEATURE_NOT_AVAILABLE', 'AI_OPERATION_IN_PROGRESS'] as const)(
      'a %s refusal keeps its code (not masked as AI_ANALYSIS_FAILED)',
      async (code) => {
        failureFetches();
        aiService.generateActionWithMetadata.mockRejectedValueOnce(
          workspaceException(code, 'refused'),
        );
        expect(await codeOf()).toBe(code);
      },
    );

    it('unparseable output is rejected by the validator before the charge (AI_ANALYSIS_FAILED)', async () => {
      failureFetches();
      let validatorThrew = false;
      aiService.generateActionWithMetadata.mockImplementationOnce(
        async (_u: string, _i: unknown, opts?: { validate?: (t: string) => void }) => {
          try {
            opts?.validate?.('this is not JSON');
          } catch (error) {
            validatorThrew = true; // AiService refunds the operation and rethrows
            throw error;
          }
          return { text: 'this is not JSON' };
        },
      );
      expect(await codeOf()).toBe('AI_ANALYSIS_FAILED');
      expect(validatorThrew).toBe(true);
    });

    it('a provider failure is still reported as AI_ANALYSIS_FAILED', async () => {
      failureFetches();
      aiService.generateActionWithMetadata.mockRejectedValueOnce(new Error('provider down'));
      expect(await codeOf()).toBe('AI_ANALYSIS_FAILED');
    });
  });
});
