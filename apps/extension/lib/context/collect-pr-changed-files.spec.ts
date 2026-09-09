import { describe, expect, it } from 'vitest';

import { collectPullRequestChangedFiles, isPullRequestFilesTab } from './collect-pr-changed-files';

describe('isPullRequestFilesTab', () => {
  it('detects /pull/N/files paths', () => {
    expect(isPullRequestFilesTab('/acme/app/pull/12/files')).toBe(true);
    expect(isPullRequestFilesTab('/acme/app/pull/12/files/')).toBe(true);
    expect(isPullRequestFilesTab('/acme/app/pull/12')).toBe(false);
    expect(isPullRequestFilesTab('/acme/app/blob/main/x.ts')).toBe(false);
  });
});

describe('collectPullRequestChangedFiles', () => {
  it('collects bounded file paths and excerpts from PR Files DOM', () => {
    document.body.innerHTML = `
      <div class="js-file" data-path="src/a.ts">
        <div class="file-info"><a data-path="src/a.ts">src/a.ts</a></div>
        <table>
          <tr><td class="blob-code-addition"><span class="blob-code-inner">+const a = 1;</span></td></tr>
          <tr><td class="blob-code-deletion"><span class="blob-code-inner">-const a = 0;</span></td></tr>
        </table>
      </div>
      <div class="js-file">
        <div class="file-info"><a data-path="src/b.ts">src/b.ts</a></div>
        <table>
          <tr><td class="blob-code-addition"><span class="blob-code-inner">+export const b = 2;</span></td></tr>
        </table>
      </div>
    `;

    const result = collectPullRequestChangedFiles(document);
    expect(result.files).toHaveLength(2);
    expect(result.files[0]?.path).toBe('src/a.ts');
    expect(result.files[0]?.patchExcerpt).toContain('const a = 1');
    expect(result.files[1]?.path).toBe('src/b.ts');
    expect(result.truncated).toBe(false);
  });

  it('falls back to data-path headers when file containers lack code', () => {
    document.body.innerHTML = `
      <div data-path="lib/util.ts"></div>
      <div data-path="lib/other.ts"></div>
    `;
    const result = collectPullRequestChangedFiles(document);
    expect(result.files.map((file) => file.path)).toEqual(['lib/util.ts', 'lib/other.ts']);
  });
});
