import type { PageContextChangedFile } from '@project-x/types';

import {
  MAX_PATH_CHARS,
  MAX_PR_CHANGED_FILES,
  MAX_PR_CHANGED_FILES_TOTAL_CHARS,
  MAX_PR_FILE_EXCERPT_CHARS,
  MAX_PR_FILE_LINES,
} from './constants';
import { truncateText } from './dom-context';

export type CollectChangedFilesResult = {
  files: PageContextChangedFile[];
  truncated: boolean;
};

function readFilePathFromContainer(container: Element): string | undefined {
  const pathEl =
    container.querySelector('[data-path]') ||
    container.querySelector('a[title][href*="/blob/"], a[title][href*="/pull/"]') ||
    container.querySelector('.file-info a') ||
    container.querySelector('.Truncate-text') ||
    container.querySelector('[class*="DiffFileHeader"] a');

  const fromAttr =
    container.getAttribute('data-path')?.trim() || pathEl?.getAttribute?.('data-path')?.trim();
  if (fromAttr) {
    return fromAttr;
  }

  const title = pathEl?.getAttribute?.('title')?.trim();
  if (title && title.includes('/') && title.length < 400) {
    return title;
  }

  const text = pathEl?.textContent?.replace(/\s+/g, ' ').trim();
  if (text && text.includes('/') && text.length < 400) {
    return text;
  }

  return undefined;
}

function readExcerptFromContainer(container: Element): string | undefined {
  const lineNodes = Array.from(
    container.querySelectorAll(
      '.blob-code-inner, td.blob-code-addition, td.blob-code-deletion, [data-code-text]',
    ),
  ).slice(0, MAX_PR_FILE_LINES);

  if (lineNodes.length === 0) {
    return undefined;
  }

  const preferDiff = lineNodes.filter((el) => {
    const row = el.closest('td, .blob-code, [data-code-marker]');
    const marker =
      row?.getAttribute('data-code-marker') ||
      (row?.classList.contains('blob-code-addition')
        ? '+'
        : row?.classList.contains('blob-code-deletion')
          ? '-'
          : '');
    const text = el.textContent ?? '';
    return marker === '+' || marker === '-' || /^[+-]/.test(text.trim());
  });

  const chosen = preferDiff.length > 0 ? preferDiff : lineNodes;
  const lines = chosen
    .map((el) => el.textContent ?? '')
    .join('\n')
    .trim();

  if (!lines) {
    return undefined;
  }

  return truncateText(lines, MAX_PR_FILE_EXCERPT_CHARS);
}

/**
 * Collect a bounded multi-file slice from a GitHub PR Files tab DOM.
 * Pure enough for unit tests — pass `document`.
 */
export function collectPullRequestChangedFiles(
  root: ParentNode = document,
): CollectChangedFilesResult {
  const containers = Array.from(
    root.querySelectorAll(
      '.js-file, .file.js-file, [data-file-type], .js-diff-progressive-container .file, diff-layout .file',
    ),
  );

  // Fallback: unique data-path headers without full file containers.
  const pathOnly = Array.from(root.querySelectorAll('[data-path]'))
    .map((el) => el.getAttribute('data-path')?.trim())
    .filter((value): value is string => Boolean(value));

  const seen = new Set<string>();
  const files: PageContextChangedFile[] = [];
  let totalChars = 0;
  let truncated = false;

  const tryAdd = (pathRaw: string, excerpt?: string) => {
    const path = truncateText(pathRaw, MAX_PATH_CHARS);
    if (!path || seen.has(path)) {
      return;
    }
    if (files.length >= MAX_PR_CHANGED_FILES) {
      truncated = true;
      return;
    }

    let patchExcerpt = excerpt;
    if (patchExcerpt) {
      const remaining = MAX_PR_CHANGED_FILES_TOTAL_CHARS - totalChars;
      if (remaining <= 0) {
        truncated = true;
        patchExcerpt = undefined;
      } else if (patchExcerpt.length > remaining) {
        patchExcerpt = truncateText(patchExcerpt, remaining);
        truncated = true;
      }
    }

    seen.add(path);
    const entry: PageContextChangedFile = { path };
    if (patchExcerpt) {
      entry.patchExcerpt = patchExcerpt;
      totalChars += patchExcerpt.length;
    }
    files.push(entry);
  };

  if (containers.length > 0) {
    for (const container of containers) {
      if (files.length >= MAX_PR_CHANGED_FILES) {
        truncated = true;
        break;
      }
      const path = readFilePathFromContainer(container);
      if (!path) {
        continue;
      }
      tryAdd(path, readExcerptFromContainer(container));
      if (totalChars >= MAX_PR_CHANGED_FILES_TOTAL_CHARS) {
        truncated = true;
        break;
      }
    }
  } else {
    for (const path of pathOnly) {
      tryAdd(path);
      if (files.length >= MAX_PR_CHANGED_FILES) {
        truncated = true;
        break;
      }
    }
  }

  const uniqueHeaderPaths = new Set(pathOnly);
  if (uniqueHeaderPaths.size > files.length) {
    truncated = true;
  }

  return { files, truncated };
}

export function isPullRequestFilesTab(pathname: string): boolean {
  return /\/pull\/\d+\/files(?:\/|$)/i.test(pathname);
}
