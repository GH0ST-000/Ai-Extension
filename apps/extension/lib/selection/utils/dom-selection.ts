import type { SelectionRect } from '../types';
import { MIN_SELECTION_LENGTH, SHADOW_HOST_ID } from '../constants';

export function toSelectionRect(rect: DOMRect): SelectionRect {
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    left: rect.left,
  };
}

export function isEmptyRect(rect: SelectionRect): boolean {
  return rect.width <= 0 && rect.height <= 0;
}

function getToolbarHost(): HTMLElement | null {
  return document.getElementById(SHADOW_HOST_ID);
}

/**
 * True when the event originated inside our Plasmo shadow host.
 * Prefer composedPath — Node.contains() cannot see into shadow roots.
 */
export function isEventFromToolbar(event: Event): boolean {
  const host = getToolbarHost();
  if (!host) {
    return false;
  }

  return event.composedPath().includes(host);
}

export function isNodeInsideToolbar(node: Node | null): boolean {
  const host = getToolbarHost();
  if (!host || !node) {
    return false;
  }

  if (node === host) {
    return true;
  }

  const root = host.shadowRoot;
  return Boolean(root?.contains(node));
}

const MIRROR_STYLE_PROPS = [
  'direction',
  'boxSizing',
  'width',
  'height',
  'overflowX',
  'overflowY',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'borderStyle',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'fontStyle',
  'fontVariant',
  'fontWeight',
  'fontStretch',
  'fontSize',
  'fontSizeAdjust',
  'lineHeight',
  'fontFamily',
  'textAlign',
  'textTransform',
  'textIndent',
  'textDecoration',
  'letterSpacing',
  'wordSpacing',
  'tabSize',
  'MozTabSize',
  'whiteSpace',
  'wordWrap',
  'wordBreak',
] as const;

/**
 * Approximate the on-screen rect of a selection inside an input/textarea.
 * GitHub's blob view uses a full-file textarea — element.getBoundingClientRect()
 * would pin Ask AI to the top of the file, not the highlighted lines.
 */
export function getFormControlSelectionRect(
  element: HTMLInputElement | HTMLTextAreaElement,
  start: number,
  end: number,
): SelectionRect | null {
  const elementRect = element.getBoundingClientRect();
  if (elementRect.width <= 0 || elementRect.height <= 0) {
    return null;
  }

  // Single-line inputs: caret mirror is less reliable; use a tight band near the field.
  if (element instanceof HTMLInputElement) {
    const height = Math.min(elementRect.height, 28);
    return toSelectionRect(
      new DOMRect(elementRect.left, elementRect.top, Math.max(elementRect.width * 0.4, 80), height),
    );
  }

  const computed = window.getComputedStyle(element);
  const mirror = document.createElement('div');
  mirror.setAttribute('data-project-x-selection-mirror', 'true');

  for (const prop of MIRROR_STYLE_PROPS) {
    mirror.style.setProperty(prop, computed.getPropertyValue(prop));
  }

  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.pointerEvents = 'none';
  mirror.style.top = '0';
  mirror.style.left = '-9999px';
  mirror.style.height = 'auto';
  mirror.style.width = `${element.clientWidth}px`;
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.overflow = 'hidden';
  mirror.style.zIndex = '-1';

  const before = document.createTextNode(element.value.slice(0, start));
  const mark = document.createElement('span');
  mark.textContent = element.value.slice(start, end) || '\u200b';
  mirror.appendChild(before);
  mirror.appendChild(mark);
  document.body.appendChild(mirror);

  try {
    const borderTop = Number.parseFloat(computed.borderTopWidth) || 0;
    const borderLeft = Number.parseFloat(computed.borderLeftWidth) || 0;
    const lineHeight = Number.parseFloat(computed.lineHeight) || mark.offsetHeight || 16;

    const top = elementRect.top + borderTop + mark.offsetTop - element.scrollTop;
    const left = elementRect.left + borderLeft + mark.offsetLeft - element.scrollLeft;
    const width = Math.max(mark.offsetWidth, 8);
    const height = Math.max(mark.offsetHeight, lineHeight);

    // Clamp into the visible textarea viewport so Floating UI stays on-screen.
    const visibleTop = Math.min(
      Math.max(top, elementRect.top),
      elementRect.bottom - Math.min(height, lineHeight),
    );
    const visibleLeft = Math.min(
      Math.max(left, elementRect.left),
      elementRect.right - Math.min(width, 24),
    );
    const visibleBottom = Math.min(visibleTop + height, elementRect.bottom);
    const visibleHeight = Math.max(visibleBottom - visibleTop, lineHeight);

    const rect = toSelectionRect(new DOMRect(visibleLeft, visibleTop, width, visibleHeight));
    if (isEmptyRect(rect)) {
      return null;
    }
    return rect;
  } finally {
    mirror.remove();
  }
}

function readFormControlSelection(
  element: HTMLInputElement | HTMLTextAreaElement,
): { text: string; rect: SelectionRect } | null {
  const start = element.selectionStart;
  const end = element.selectionEnd;
  if (start === null || end === null || start === end) {
    return null;
  }

  const text = element.value
    .slice(start, end)
    .replace(/\u00a0/g, ' ')
    .trim();
  if (text.length < MIN_SELECTION_LENGTH) {
    return null;
  }

  const rect = getFormControlSelectionRect(element, start, end);
  if (!rect || isEmptyRect(rect)) {
    return null;
  }

  return { text, rect };
}

function readWindowSelection(): { text: string; rect: SelectionRect } | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }

  const text = selection
    .toString()
    .replace(/\u00a0/g, ' ')
    .trim();
  if (text.length < MIN_SELECTION_LENGTH) {
    return null;
  }

  if (isNodeInsideToolbar(selection.anchorNode)) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const rect = toSelectionRect(range.getBoundingClientRect());
  if (isEmptyRect(rect)) {
    return null;
  }

  return { text, rect };
}

/**
 * Read the current user selection, ignoring collapsed / whitespace-only ranges
 * and selections that originate inside our toolbar host.
 */
export function readDomSelection(): { text: string; rect: SelectionRect } | null {
  // Prefer a real DOM Range when it has geometry (generic pages, many code hosts).
  const windowSelection = readWindowSelection();
  if (windowSelection) {
    return windowSelection;
  }

  const active = document.activeElement;
  if (
    (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) &&
    !isNodeInsideToolbar(active)
  ) {
    return readFormControlSelection(active);
  }

  return null;
}

export function createVirtualElement(rect: SelectionRect) {
  return {
    getBoundingClientRect: () => ({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      left: rect.left,
    }),
  };
}
