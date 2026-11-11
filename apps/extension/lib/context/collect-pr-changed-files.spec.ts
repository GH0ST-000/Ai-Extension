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

  it('reports an empty page as empty, not truncated', () => {
    document.body.innerHTML = '<div class="js-discussion"><p>Conversation</p></div>';
    expect(collectPullRequestChangedFiles(document)).toEqual({ files: [], truncated: false });
  });

  it('falls back to header paths when matched containers have no readable path', () => {
    document.body.innerHTML = `
      <div data-file-type=".ts"><span>no path</span></div>
      <h3 data-path="src/a.ts"></h3><h3 data-path="src/b.ts"></h3>
    `;
    const result = collectPullRequestChangedFiles(document);
    expect(result.files.map((file) => file.path)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('reads the React "Files changed" layout', () => {
    document.body.innerHTML = `
      <div id="diff-abc123">
        <h3><a href="#diff-abc123"><code>‎apps/api/src/memory.ts‎</code></a></h3>
        <table>
          <tr><td class="diff-text-cell addition"><code class="diff-text">+const ws = req.ws;</code></td></tr>
          <tr><td class="diff-text-cell"><code class="diff-text"> unchanged</code></td></tr>
        </table>
      </div>
      <div data-tagsearch-path="apps/web/page.tsx">
        <table><tr><td class="diff-text-cell deletion"><code class="diff-text">-old()</code></td></tr></table>
      </div>
    `;
    const result = collectPullRequestChangedFiles(document);
    expect(result.files).toEqual([
      { path: 'apps/api/src/memory.ts', patchExcerpt: '+const ws = req.ws;' },
      { path: 'apps/web/page.tsx', patchExcerpt: '-old()' },
    ]);
  });
});

describe('isPullRequestFilesTab (new route)', () => {
  it('accepts /changes', () => {
    expect(isPullRequestFilesTab('/GH0ST-000/Ai-Extension/pull/48/changes')).toBe(true);
  });
});
