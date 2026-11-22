import { UnprocessableEntityException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PR_DIFF_MAX_PAGES, PullRequestDiffService } from './pull-request-diff.service';
import { repositoryAccessStub } from '../../github-app/github-access.test-helpers';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

describe('PullRequestDiffService', () => {
  const resolveApiToken = vi.fn();
  const service = new PullRequestDiffService(
    repositoryAccessStub({}, () => resolveApiToken()) as never,
  );
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
          head: { ref: 'fix', sha: 'abc1234def' },
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
    // Every listed file is returned (no selection here); budgeting happens in the planner.
    expect(result).toMatchObject({ source: 'github_api', totalFiles: 101 });
    expect(result.files).toHaveLength(101);
    expect(result.files.at(-1)).toEqual({
      path: 'src/last.ts',
      status: 'modified',
      changes: 0,
      patch: '+y',
    });
    expect(result).toMatchObject({
      pullRequestTitle: 'Memory fixes',
      baseBranch: 'main',
      headBranch: 'fix',
      headSha: 'abc1234def',
    });
  });

  it(`stops at ${PR_DIFF_MAX_PAGES} pages and keeps GitHub's total so the rest count as not fetched`, async () => {
    const page = (n: number) =>
      Array.from({ length: 100 }, (_, i) => ({ filename: `p${n}/f${i}.ts`, patch: '+x' }));
    fetchMock.mockResolvedValueOnce(json({ changed_files: 2500 }));
    for (let n = 1; n <= PR_DIFF_MAX_PAGES + 2; n += 1)
      fetchMock.mockResolvedValueOnce(json(page(n)));

    const result = await service.resolve({ ...base, pullRequestNumber: 7 });

    expect(fetchMock).toHaveBeenCalledTimes(1 + PR_DIFF_MAX_PAGES);
    expect(result.files).toHaveLength(PR_DIFF_MAX_PAGES * 100);
    expect(result.totalFiles).toBe(2500);
  });

  it('keeps files without a patch (binary / too large) instead of dropping them', async () => {
    fetchMock.mockResolvedValueOnce(json({ changed_files: 2 })).mockResolvedValueOnce(
      json([
        { filename: 'logo.png', status: 'added', changes: 0 },
        { filename: 'src/huge.ts', status: 'modified', changes: 9000 },
      ]),
    );
    const result = await service.resolve({ ...base, pullRequestNumber: 9 });
    expect(result.files.map((f) => [f.path, f.patch])).toEqual([
      ['logo.png', null],
      ['src/huge.ts', null],
    ]);
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
    expect(result.files.map((f) => f.path)).toEqual(['api.ts']);
  });

  it('falls back to page diff when GitHub denies access', async () => {
    fetchMock.mockResolvedValueOnce(json({ message: 'Not Found' }, 404));
    const result = await service.resolve({
      ...base,
      pullRequestNumber: 48,
      pageFiles: [{ path: 'dom.ts', patchExcerpt: '+dom' }],
    });
    expect(result).toMatchObject({ source: 'page', totalFiles: null });
    expect(result.files).toEqual([
      { path: 'dom.ts', status: 'modified', changes: 1, patch: '+dom' },
    ]);
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
