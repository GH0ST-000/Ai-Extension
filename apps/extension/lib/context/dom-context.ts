/**
 * Truncate a string to at most `max` characters, preferring a middle window
 * around `anchor` when provided.
 */
export function truncateText(value: string, max: number, options?: { anchor?: string }): string {
  const normalized = value
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
  if (normalized.length <= max) {
    return normalized;
  }

  const anchor = options?.anchor?.trim();
  if (anchor) {
    const index = normalized.indexOf(anchor);
    if (index >= 0) {
      const half = Math.floor((max - anchor.length) / 2);
      const start = Math.max(0, index - half);
      const end = Math.min(normalized.length, start + max);
      const slice = normalized.slice(start, end);
      const prefix = start > 0 ? '…' : '';
      const suffix = end < normalized.length ? '…' : '';
      return `${prefix}${slice}${suffix}`.slice(0, max);
    }
  }

  return `${normalized.slice(0, Math.max(0, max - 1))}…`;
}

export function readMetaDescription(): string | undefined {
  const el =
    document.querySelector('meta[name="description"]') ||
    document.querySelector('meta[property="og:description"]');
  const content = el?.getAttribute('content')?.trim();
  return content && content.length > 0 ? content : undefined;
}

export function languageFromFileName(fileName: string | undefined): string | undefined {
  if (!fileName) {
    return undefined;
  }
  const base = fileName.split('/').pop() ?? fileName;
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) {
    return undefined;
  }
  return base.slice(dot + 1).toLowerCase();
}

const BLOCK_TAGS = new Set([
  'P',
  'DIV',
  'ARTICLE',
  'SECTION',
  'MAIN',
  'LI',
  'TD',
  'TH',
  'PRE',
  'BLOCKQUOTE',
  'FIGCAPTION',
]);

function isBlockish(el: Element): boolean {
  return BLOCK_TAGS.has(el.tagName);
}

/**
 * Collect limited surrounding text around the current selection from a nearby
 * block ancestor. Never walks the full document.
 */
export function extractSurroundingText(selectedText: string, maxChars: number): string | undefined {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return undefined;
  }

  const range = selection.getRangeAt(0);
  let node: Node | null = range.commonAncestorContainer;
  if (node.nodeType === Node.TEXT_NODE) {
    node = node.parentElement;
  }

  let element = node instanceof Element ? node : null;
  if (!element) {
    return undefined;
  }

  let depth = 0;
  while (element.parentElement && !isBlockish(element) && depth < 8) {
    if (element.id === 'project-x-selection-toolbar') {
      return undefined;
    }
    element = element.parentElement;
    depth += 1;
  }

  const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
  if (!text || text === selectedText.trim()) {
    return undefined;
  }

  return truncateText(text, maxChars, { anchor: selectedText.trim() });
}

/**
 * If the selection is inside a code-like element, return a truncated slice of
 * that element's text as surrounding code.
 */
export function extractSurroundingCode(selectedText: string, maxChars: number): string | undefined {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return undefined;
  }

  let node: Node | null = selection.getRangeAt(0).commonAncestorContainer;
  if (node.nodeType === Node.TEXT_NODE) {
    node = node.parentElement;
  }

  let element = node instanceof Element ? node : null;
  while (element && element !== document.body) {
    const tag = element.tagName;
    const isCodeLike =
      tag === 'PRE' ||
      tag === 'CODE' ||
      element.classList.contains('blob-code') ||
      element.classList.contains('blob-code-inner') ||
      element.hasAttribute('data-code-text') ||
      element.getAttribute('data-testid') === 'read-only-cursor-text-area';

    if (isCodeLike) {
      const host =
        tag === 'CODE' && element.parentElement?.tagName === 'PRE'
          ? element.parentElement
          : element;
      const text = (host.textContent ?? '').replace(/\u00a0/g, ' ');
      const trimmed = text.trim();
      if (!trimmed) {
        return undefined;
      }
      return truncateText(trimmed, maxChars, { anchor: selectedText.trim() });
    }

    element = element.parentElement;
  }

  return undefined;
}
