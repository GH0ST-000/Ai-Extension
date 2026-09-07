import type { PageContext } from '@project-x/types';

import {
  MAX_PAGE_DESCRIPTION_CHARS,
  MAX_SURROUNDING_CODE_CHARS,
  MAX_SURROUNDING_TEXT_CHARS,
  MAX_TITLE_CHARS,
  MAX_URL_CHARS,
} from '../constants';
import {
  extractSurroundingCode,
  extractSurroundingText,
  readMetaDescription,
  truncateText,
} from '../dom-context';
import type { PageAdapter } from '../page-adapter';

function compactPageUrl(url: URL): string {
  return `${url.origin}${url.pathname}`.replace(/\/$/, '') || url.origin;
}

function buildGenericContext(url: URL, selectedText: string): PageContext {
  const surroundingCode = extractSurroundingCode(selectedText, MAX_SURROUNDING_CODE_CHARS);
  // When code context exists, skip prose surroundings — denser signal, fewer tokens.
  const surroundingText = surroundingCode
    ? undefined
    : extractSurroundingText(selectedText, MAX_SURROUNDING_TEXT_CHARS);
  const description = readMetaDescription();

  const context: PageContext = {
    type: 'generic',
    url: truncateText(compactPageUrl(url), MAX_URL_CHARS),
    title: truncateText(document.title || url.hostname, MAX_TITLE_CHARS),
  };

  if (surroundingText && surroundingText !== selectedText.trim()) {
    context.surroundingText = surroundingText;
  }

  if (description && description !== context.title) {
    context.page = {
      description: truncateText(description, MAX_PAGE_DESCRIPTION_CHARS),
    };
  }

  if (surroundingCode) {
    context.code = { surroundingCode };
  }

  return context;
}

export const genericPageAdapter: PageAdapter = {
  matches: () => true,
  extract: (url) => {
    const selectedText = window.getSelection()?.toString() ?? '';
    return buildGenericContext(url, selectedText);
  },
};

export { buildGenericContext };
