import { UnprocessableEntityException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PullRequestDiffService } from './pull-request-diff.service';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

describe('PullRequestDiffService', () => {
  const resolveApiToken = vi.fn();
  const service = new PullRequestDiffService({ resolveApiToken } as never);
  const fetchMock = vi.fn();
  const originalFetch = global.fetch;
  const base = { userId: 'u1', workspaceId: 'ws1', owner: 'GH0ST-000', repository: 'Ai-Extension' };

  beforeEach(() => {
    resolveApiToken.mockReset().mockResolvedValue({ token: 't', source: 'pat' });
    fetchMock.mockReset();
    global.fetch = fetchMock as never;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  async function expectUnavailable(promise: Promise<unknown>, reason: string) {
    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect((error as UnprocessableEntityException).getResponse()).toMatchObject({
      code: 'PR_DIFF_UNAVAILABLE',
      reason,
    });
  }

  it('loads every page of PR files from the GitHub API', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      filename: `src/f${i}.ts`,
      patch: '+x',
    }));
    fetchMock
      .mockResolvedValueOnce(
        json({
          title: 'Memory fixes',
          changed_files: 101,
          base: { ref: 'main' },
          head: { ref: 'fix' },
        }),
      )
      .mockResolvedValueOnce(json(page1))
      .mockResolvedValueOnce(json([{ filename: 'src/last.ts', patch: '+y' }]));

    const result = await service.resolve({ ...base, pullRequestNumber: 48 });

    expect(fetchMock.mock.calls.map((c) => String(c[0]))).toEqual([
      'https://api.github.com/repos/GH0ST-000/Ai-Extension/pulls/48',
      'https://api.github.com/repos/GH0ST-000/Ai-Extension/pulls/48/files?per_page=100&page=1',
      'https://api.github.com/repos/GH0ST-000/Ai-Extension/pulls/48/files?per_page=100&page=2',
    ]);
    expect(result.scope).toMatchObject({ source: 'github_api', totalFiles: 101, truncated: true });
    expect(result.scope.analyzedFiles).toBeGreaterThan(0);
    expect(result).toMatchObject({
      pullRequestTitle: 'Memory fixes',
      baseBranch: 'main',
      headBranch: 'fix',
    });
  });

  it('ignores page files when the API succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ changed_files: 1 }))
      .mockResolvedValueOnce(json([{ filename: 'api.ts', patch: '+a' }]));
    const result = await service.resolve({
      ...base,
      pullRequestNumber: 48,
      pageFiles: [{ path: 'dom.ts', patchExcerpt: '+dom' }],
    });
    expect(result.changedFiles.map((f) => f.path)).toEqual(['api.ts']);
  });

  it('falls back to page diff when GitHub denies access', async () => {
    fetchMock.mockResolvedValueOnce(json({ message: 'Not Found' }, 404));
    const result = await service.resolve({
      ...base,
      pullRequestNumber: 48,
      pageFiles: [{ path: 'dom.ts', patchExcerpt: '+dom' }],
    });
    expect(result.scope).toMatchObject({ source: 'page', analyzedFiles: 1, totalFiles: null });
  });

  it('rejects with PR_DIFF_UNAVAILABLE when there is no token and no page diff', async () => {
    resolveApiToken.mockResolvedValueOnce(null);
    await expectUnavailable(
      service.resolve({ ...base, pullRequestNumber: 48, pageFiles: [{ path: 'no-diff.ts' }] }),
      'not_connected',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps GitHub statuses to reasons', async () => {
    fetchMock.mockResolvedValueOnce(json({}, 401));
    await expectUnavailable(service.resolve({ ...base, pullRequestNumber: 48 }), 'token_rejected');
    fetchMock.mockResolvedValueOnce(json({}, 403, { 'x-ratelimit-remaining': '0' }));
    await expectUnavailable(service.resolve({ ...base, pullRequestNumber: 48 }), 'unavailable');
    fetchMock.mockResolvedValueOnce(json({}, 403));
    await expectUnavailable(service.resolve({ ...base, pullRequestNumber: 48 }), 'no_access');
    fetchMock.mockRejectedValueOnce(new Error('network'));
    await expectUnavailable(service.resolve({ ...base, pullRequestNumber: 48 }), 'unavailable');
  });

  it('refuses malformed PR identity without calling GitHub', async () => {
    await expectUnavailable(service.resolve({ ...base, pullRequestNumber: 0 }), 'not_a_pr');
    await expectUnavailable(
      service.resolve({ ...base, owner: '../evil', pullRequestNumber: 1 }),
      'not_a_pr',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
