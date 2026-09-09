import type { PageContext, PageContextGitHub } from '@project-x/types';

import { collectPullRequestChangedFiles, isPullRequestFilesTab } from '../collect-pr-changed-files';
import {
  MAX_PATH_CHARS,
  MAX_PR_BODY_CHARS,
  MAX_SURROUNDING_CODE_CHARS,
  MAX_SURROUNDING_TEXT_CHARS,
  MAX_TITLE_CHARS,
  MAX_URL_CHARS,
} from '../constants';
import {
  extractSurroundingCode,
  extractSurroundingText,
  languageFromFileName,
  truncateText,
} from '../dom-context';
import type { PageAdapter } from '../page-adapter';
import { buildGenericContext } from './generic.adapter';

export type ParsedGitHubUrl = {
  owner: string;
  repository: string;
  branch?: string;
  filePath?: string;
  pullRequestNumber?: number;
  /** True when URL is under /pull/{n} (including /files, /commits, …). */
  isPullRequest?: boolean;
};

/**
 * Parse common GitHub URL shapes. Pure function for unit tests.
 */
export function parseGitHubUrl(url: URL): ParsedGitHubUrl | null {
  const host = url.hostname.toLowerCase();
  if (host !== 'github.com' && host !== 'www.github.com') {
    return null;
  }

  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2) {
    return null;
  }

  const [owner, repository, section, ...rest] = parts;
  if (!owner || !repository) {
    return null;
  }

  const base: ParsedGitHubUrl = { owner, repository };

  if (section === 'blob' || section === 'tree') {
    const branch = rest[0];
    const filePath = rest.slice(1).join('/');
    return {
      ...base,
      branch: branch || undefined,
      filePath: filePath || undefined,
    };
  }

  if (section === 'pull') {
    const number = Number.parseInt(rest[0] ?? '', 10);
    return {
      ...base,
      isPullRequest: true,
      pullRequestNumber: Number.isFinite(number) ? number : undefined,
    };
  }

  return base;
}

function readText(selector: string): string | undefined {
  const el = document.querySelector(selector);
  const text = el?.textContent?.replace(/\s+/g, ' ').trim();
  return text || undefined;
}

function readPullRequestTitle(): string | undefined {
  const selectors = [
    '.js-issue-title',
    'bdi.js-issue-title',
    'span.js-issue-title',
    'h1.gh-header-title .js-issue-title',
    '[data-testid="issue-title"]',
  ];

  for (const selector of selectors) {
    const text = readText(selector);
    if (text) {
      return text;
    }
  }

  return undefined;
}

function readPullRequestBody(): string | undefined {
  const selectors = [
    '.js-comment-body',
    '[data-testid="pull-request-body"]',
    '.comment-body.markdown-body',
    '#discussion_bucket .js-comment-body',
  ];

  for (const selector of selectors) {
    const el = document.querySelector(selector);
    const text = el?.textContent?.replace(/\s+/g, ' ').trim();
    if (text && text.length > 20) {
      return truncateText(text, MAX_PR_BODY_CHARS);
    }
  }

  return undefined;
}

/**
 * GitHub PR header shows base ← head as linked branch names.
 */
function readPullRequestBranches(): { baseBranch?: string; headBranch?: string } {
  const commitish = Array.from(
    document.querySelectorAll(
      '.gh-header-meta .commit-ref, .gh-header-meta .css-truncate-target, [class*="Commitish"] a, span.commit-ref',
    ),
  )
    .map((el) => el.textContent?.replace(/\s+/g, ' ').trim())
    .filter((value): value is string => Boolean(value && value.length > 0 && value.length < 200));

  // Typical order in header: base then head (or head then base depending on UI).
  // Prefer explicit range text "base ... head".
  const range = document.querySelector('.gh-header-meta')?.textContent?.replace(/\s+/g, ' ').trim();

  if (range) {
    const match = range.match(/(?:into|merge)\s+(\S+)\s+from\s+(\S+)|(\S+)\s*[←\-–—]+\s*(\S+)/i);
    if (match) {
      if (match[1] && match[2]) {
        return { baseBranch: match[1], headBranch: match[2] };
      }
      if (match[3] && match[4]) {
        return { baseBranch: match[3], headBranch: match[4] };
      }
    }
  }

  if (commitish.length >= 2) {
    return { baseBranch: commitish[0], headBranch: commitish[1] };
  }

  return {};
}

function readDiffFilePathNearSelection(): string | undefined {
  const selection = window.getSelection();
  const node = selection?.anchorNode;
  const element = node instanceof Element ? node : node?.parentElement;
  if (!element) {
    return undefined;
  }

  const fileHeader = element.closest(
    '.file, .js-file, [data-file-type], .diff-view .js-diff-progressive-container',
  );
  if (!fileHeader) {
    return undefined;
  }

  const pathEl =
    fileHeader.querySelector('[data-path]') ||
    fileHeader.querySelector('a[title]') ||
    fileHeader.querySelector('.file-info a') ||
    fileHeader.querySelector('.Truncate-text');

  const fromAttr = pathEl?.getAttribute?.('data-path')?.trim();
  if (fromAttr) {
    return fromAttr;
  }

  const title = pathEl?.getAttribute?.('title')?.trim();
  if (title && !title.includes(' ')) {
    return title;
  }

  const text = pathEl?.textContent?.replace(/\s+/g, ' ').trim();
  return text || undefined;
}

function readPullRequestDiffCode(selectedText: string): string | undefined {
  const fromSelection = extractSurroundingCode(selectedText, MAX_SURROUNDING_CODE_CHARS);
  if (fromSelection) {
    return fromSelection;
  }

  const selection = window.getSelection();
  const node = selection?.anchorNode;
  const element = node instanceof Element ? node : node?.parentElement;
  const row = element?.closest('tr, .blob-code, [data-code-marker], .js-file-line');
  if (row) {
    const table = row.closest('table, .diff-table, .js-diff-table');
    if (table) {
      const lines = Array.from(
        table.querySelectorAll(
          '.blob-code-inner, td.blob-code-addition, td.blob-code-deletion, td.blob-code-context, [data-code-text]',
        ),
      )
        .map((el) => el.textContent ?? '')
        .join('\n')
        .trim();
      if (lines) {
        return truncateText(lines, MAX_SURROUNDING_CODE_CHARS, {
          anchor: selectedText.trim(),
        });
      }
    }
  }

  // Visible diff hunks on the Files tab (best-effort, capped).
  const hunkLines = Array.from(
    document.querySelectorAll(
      '.js-file-content .blob-code-inner, .js-diff-progressive-container .blob-code-inner, [data-code-text]',
    ),
  )
    .slice(0, 120)
    .map((el) => el.textContent ?? '')
    .join('\n')
    .trim();

  if (!hunkLines) {
    return undefined;
  }

  return truncateText(hunkLines, MAX_SURROUNDING_CODE_CHARS, {
    anchor: selectedText.trim(),
  });
}

function readGitHubFileCode(selectedText: string): string | undefined {
  const fromSelection = extractSurroundingCode(selectedText, MAX_SURROUNDING_CODE_CHARS);
  if (fromSelection) {
    return fromSelection;
  }

  const textarea = document.querySelector(
    'textarea#read-only-cursor-text-area, textarea[data-testid="read-only-cursor-text-area"]',
  ) as HTMLTextAreaElement | null;
  if (textarea?.value?.trim()) {
    return truncateText(textarea.value, MAX_SURROUNDING_CODE_CHARS, {
      anchor: selectedText.trim(),
    });
  }

  const lines = Array.from(
    document.querySelectorAll('.blob-code-inner, td.blob-code-inner, [data-code-text]'),
  )
    .map((el) => el.textContent ?? '')
    .join('\n')
    .trim();

  if (!lines) {
    return undefined;
  }

  return truncateText(lines, MAX_SURROUNDING_CODE_CHARS, { anchor: selectedText.trim() });
}

function buildGitHubContext(url: URL, selectedText: string): PageContext {
  const parsed = parseGitHubUrl(url);
  const generic = buildGenericContext(url, selectedText);

  if (!parsed) {
    return generic;
  }

  const isPr = parsed.isPullRequest === true;
  const diffFilePath = isPr ? readDiffFilePathNearSelection() : undefined;
  const filePath = parsed.filePath ?? diffFilePath;
  const fileName = filePath?.split('/').pop();

  const surroundingCode = isPr
    ? readPullRequestDiffCode(selectedText)
    : readGitHubFileCode(selectedText);

  const surroundingText = surroundingCode
    ? undefined
    : (extractSurroundingText(selectedText, MAX_SURROUNDING_TEXT_CHARS) ?? generic.surroundingText);

  const github: PageContextGitHub = {
    owner: parsed.owner,
    repository: parsed.repository,
  };

  if (parsed.branch) {
    github.branch = truncateText(parsed.branch, MAX_PATH_CHARS);
  }
  if (filePath) {
    github.filePath = truncateText(filePath, MAX_PATH_CHARS);
  }

  if (parsed.pullRequestNumber) {
    github.pullRequestNumber = parsed.pullRequestNumber;
    const prTitle = readPullRequestTitle();
    if (prTitle) {
      github.pullRequestTitle = truncateText(prTitle, MAX_TITLE_CHARS);
    }
    const prBody = readPullRequestBody();
    if (prBody) {
      github.pullRequestBody = prBody;
    }
    const branches = readPullRequestBranches();
    if (branches.baseBranch) {
      github.baseBranch = truncateText(branches.baseBranch, MAX_PATH_CHARS);
    }
    if (branches.headBranch) {
      github.headBranch = truncateText(branches.headBranch, MAX_PATH_CHARS);
    }

    const filesTab = isPullRequestFilesTab(url.pathname);
    github.filesTab = filesTab;
    const collected = collectPullRequestChangedFiles(document);
    if (collected.files.length > 0) {
      github.changedFiles = collected.files;
    }
    if (collected.truncated || collected.files.length === 0) {
      github.changedFilesTruncated = true;
    }
  }

  const compactUrl = `${url.origin}${url.pathname}`.replace(/\/$/, '') || url.origin;

  const context: PageContext = {
    type: 'github',
    url: truncateText(compactUrl, MAX_URL_CHARS),
    title: truncateText(document.title || `${parsed.owner}/${parsed.repository}`, MAX_TITLE_CHARS),
    github,
  };

  if (surroundingText && surroundingText !== selectedText.trim()) {
    context.surroundingText = surroundingText;
  }

  if (surroundingCode || fileName) {
    context.code = {
      fileName: fileName ? truncateText(fileName, MAX_PATH_CHARS) : undefined,
      language: languageFromFileName(fileName),
      surroundingCode,
    };
  }

  return context;
}

export const githubPageAdapter: PageAdapter = {
  matches: (url) => {
    const host = url.hostname.toLowerCase();
    return host === 'github.com' || host === 'www.github.com';
  },
  extract: (url) => {
    const selectedText = window.getSelection()?.toString() ?? '';
    return buildGitHubContext(url, selectedText);
  },
};
