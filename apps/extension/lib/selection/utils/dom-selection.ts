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

/**
 * Read the current user selection, ignoring collapsed / whitespace-only ranges
 * and selections that originate inside our toolbar host.
 */
export function readDomSelection(): { text: string; rect: SelectionRect } | null {
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
