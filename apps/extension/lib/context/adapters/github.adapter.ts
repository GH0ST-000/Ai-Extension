import type { PageContext, PageContextGitHub } from '@project-x/types';

import {
  MAX_PATH_CHARS,
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
      pullRequestNumber: Number.isFinite(number) ? number : undefined,
    };
  }

  return base;
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
    const el = document.querySelector(selector);
    const text = el?.textContent?.replace(/\s+/g, ' ').trim();
    if (text) {
      return text;
    }
  }

  return undefined;
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

  const fileName = parsed.filePath?.split('/').pop();
  const surroundingCode = readGitHubFileCode(selectedText);
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
  if (parsed.filePath) {
    github.filePath = truncateText(parsed.filePath, MAX_PATH_CHARS);
  }
  if (parsed.pullRequestNumber) {
    github.pullRequestNumber = parsed.pullRequestNumber;
    const prTitle = readPullRequestTitle();
    if (prTitle) {
      github.pullRequestTitle = truncateText(prTitle, MAX_TITLE_CHARS);
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
