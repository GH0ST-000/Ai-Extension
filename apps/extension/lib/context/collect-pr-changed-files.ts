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

/** Attributes GitHub's classic and React diff views use to carry a file path. */
const PATH_ATTRS = ['data-path', 'data-tagsearch-path', 'data-file-path'] as const;
const PATH_ATTR_SELECTOR = PATH_ATTRS.map((attr) => `[${attr}]`).join(', ');

function readPathAttr(el: Element | null | undefined): string | undefined {
  if (!el) return undefined;
  for (const attr of PATH_ATTRS) {
    const value = el.getAttribute(attr)?.trim();
    if (value) return value;
  }
  return undefined;
}

function readFilePathFromContainer(container: Element): string | undefined {
  const pathEl =
    container.querySelector(PATH_ATTR_SELECTOR) ||
    container.querySelector('a[title][href*="/blob/"], a[title][href*="/pull/"]') ||
    container.querySelector('.file-info a') ||
    container.querySelector('.Truncate-text') ||
    container.querySelector('[class*="DiffFileHeader"] a') ||
    // React "Files changed" view: header link to the file anchor, path in <code>.
    container.querySelector('h3 a[href^="#diff-"], [class*="file-header"] a[href^="#diff-"]') ||
    container.querySelector('h3 code');

  const fromAttr = readPathAttr(container) || readPathAttr(pathEl);
  if (fromAttr) {
    return fromAttr;
  }

  const title = pathEl?.getAttribute?.('title')?.trim();
  if (title && title.includes('/') && title.length < 400) {
    return title;
  }

  // Strip invisible direction marks GitHub wraps around paths in the React view.
  const text = pathEl?.textContent
    ?.replace(/[‎‏‪-‮]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text && text.includes('/') && text.length < 400) {
    return text;
  }

  return undefined;
}

function diffMarker(el: Element): string {
  const row = el.closest('td, .blob-code, [data-code-marker], .diff-text-cell');
  const marker = row?.getAttribute('data-code-marker');
  if (marker) return marker;
  const classes = `${row?.className ?? ''} ${el.className ?? ''}`;
  if (/\b(blob-code-addition|addition)\b/.test(classes)) return '+';
  if (/\b(blob-code-deletion|deletion)\b/.test(classes)) return '-';
  return '';
}

function readExcerptFromContainer(container: Element): string | undefined {
  const lineNodes = Array.from(
    container.querySelectorAll(
      '.blob-code-inner, td.blob-code-addition, td.blob-code-deletion, [data-code-text], .diff-text-cell code, code.diff-text',
    ),
  ).slice(0, MAX_PR_FILE_LINES);

  if (lineNodes.length === 0) {
    return undefined;
  }

  const preferDiff = lineNodes.filter((el) => {
    const marker = diffMarker(el);
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
      '.js-file, .file.js-file, [data-file-type], .js-diff-progressive-container .file, diff-layout .file, [data-tagsearch-path], div[data-file-path], div[id^="diff-"]',
    ),
  );

  // Fallback: unique path headers without full file containers.
  const pathOnly = [
    ...new Set(
      Array.from(root.querySelectorAll(PATH_ATTR_SELECTOR))
        .map((el) => readPathAttr(el))
        .filter((value): value is string => Boolean(value)),
    ),
  ];

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

  // Containers matched but none yielded a path (unknown layout): use header paths so the
  // review at least knows which files changed, instead of reporting zero files.
  if (files.length === 0) {
    for (const path of pathOnly) {
      tryAdd(path);
      if (files.length >= MAX_PR_CHANGED_FILES) {
        break;
      }
    }
  }

  const unseenHeaderPaths = pathOnly.filter((path) => !seen.has(path));
  if (files.length > 0 && unseenHeaderPaths.length > 0) {
    truncated = true;
  }

  return { files, truncated };
}

/** PR diff tab: classic `/files` and the newer `/changes` route. */
export function isPullRequestFilesTab(pathname: string): boolean {
  return /\/pull\/\d+\/(?:files|changes)(?:\/|$)/i.test(pathname);
}
