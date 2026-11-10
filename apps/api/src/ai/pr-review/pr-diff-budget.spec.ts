import { describe, expect, it } from 'vitest';

import {
  budgetPullRequestFiles,
  isGeneratedOrLockFile,
  PR_DIFF_MAX_FILE_CHARS,
  PR_DIFF_MAX_FILES,
  PR_DIFF_MAX_TOTAL_CHARS,
  scopeFromPageFiles,
} from './pr-diff-budget';

const patch = (n: number) => Array.from({ length: n }, (_, i) => `+line ${i}`).join('\n');

describe('budgetPullRequestFiles', () => {
  it('sends every reviewable file and reports a complete scope', () => {
    const { changedFiles, scope } = budgetPullRequestFiles(
      [
        { filename: 'src/a.ts', patch: '+a' },
        { filename: 'src/b.ts', patch: '-b' },
      ],
      2,
    );
    expect(changedFiles.map((f) => f.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(scope).toEqual({
      source: 'github_api',
      totalFiles: 2,
      analyzedFiles: 2,
      skippedFiles: 0,
      truncated: false,
    });
  });

  it('lists lockfiles and binaries by path only and counts them as skipped', () => {
    const { changedFiles, scope } = budgetPullRequestFiles(
      [
        { filename: 'pnpm-lock.yaml', patch: '+x' },
        { filename: 'logo.png' },
        { filename: 'src/a.ts', patch: '+a' },
      ],
      3,
    );
    expect(changedFiles[0]).toEqual({ path: 'src/a.ts', patchExcerpt: '+a' });
    expect(changedFiles.slice(1).every((f) => f.patchExcerpt === undefined)).toBe(true);
    expect(scope.analyzedFiles).toBe(1);
    expect(scope.skippedFiles).toBe(2);
    expect(scope.truncated).toBe(true);
  });

  it('caps per-file and total diff size and marks the scope truncated', () => {
    const files = Array.from({ length: 30 }, (_, i) => ({
      filename: `src/f${i}.ts`,
      patch: patch(2_000),
    }));
    const { changedFiles, scope } = budgetPullRequestFiles(files, 30);
    const chars = changedFiles.reduce((n, f) => n + (f.patchExcerpt?.length ?? 0), 0);
    expect(chars).toBeLessThanOrEqual(PR_DIFF_MAX_TOTAL_CHARS + 200);
    expect(
      changedFiles.every((f) => (f.patchExcerpt?.length ?? 0) <= PR_DIFF_MAX_FILE_CHARS + 30),
    ).toBe(true);
    expect(changedFiles[0]!.patchExcerpt).toContain('[diff truncated]');
    expect(scope.analyzedFiles).toBeLessThan(30);
    expect(scope.analyzedFiles + scope.skippedFiles).toBe(30);
    expect(scope.truncated).toBe(true);
  });

  it('never sends more than the file cap', () => {
    const files = Array.from({ length: 120 }, (_, i) => ({ filename: `f${i}.ts`, patch: '+x' }));
    const { changedFiles, scope } = budgetPullRequestFiles(files, 120);
    expect(changedFiles).toHaveLength(PR_DIFF_MAX_FILES);
    expect(scope).toMatchObject({ totalFiles: 120, analyzedFiles: PR_DIFF_MAX_FILES });
  });

  it('uses the PR total when GitHub returned fewer files than changed', () => {
    const { scope } = budgetPullRequestFiles([{ filename: 'a.ts', patch: '+a' }], 500);
    expect(scope).toMatchObject({ totalFiles: 500, analyzedFiles: 1, skippedFiles: 499 });
  });
});

describe('isGeneratedOrLockFile', () => {
  it.each([
    ['pnpm-lock.yaml', true],
    ['apps/web/dist/main.js', true],
    ['x.min.js', true],
    ['src/locks.ts', false],
    ['src/dist-utils.ts', false],
  ])('%s → %s', (path, expected) => {
    expect(isGeneratedOrLockFile(path)).toBe(expected);
  });
});

describe('scopeFromPageFiles', () => {
  it('counts only files with diff text as analyzed', () => {
    expect(scopeFromPageFiles([{ path: 'a', patchExcerpt: '+a' }, { path: 'b' }], false)).toEqual({
      source: 'page',
      totalFiles: null,
      analyzedFiles: 1,
      skippedFiles: 1,
      truncated: true,
    });
    expect(scopeFromPageFiles(undefined, false).analyzedFiles).toBe(0);
  });
});
