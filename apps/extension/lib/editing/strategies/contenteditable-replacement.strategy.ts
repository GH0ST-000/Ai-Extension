import type { EditableSelectionSnapshot, ReplacementResult } from '../editing.types';
import { dispatchEditableChangeEvents } from '../utils/editable-events';

/**
 * Replace a text range inside a contenteditable host using a Range when possible.
 */
export function replaceContentEditableSelection(
  snapshot: EditableSelectionSnapshot,
  replacement: string,
): ReplacementResult {
  if (snapshot.kind !== 'contenteditable') {
    return { ok: false, reason: 'unsupported', message: 'Not a contenteditable snapshot.' };
  }

  const element = snapshot.element;
  if (!(element instanceof HTMLElement) || !element.isConnected) {
    return {
      ok: false,
      reason: 'element-detached',
      message: 'The editable area is no longer on the page.',
    };
  }

  if (!element.isContentEditable) {
    return {
      ok: false,
      reason: 'element-locked',
      message: 'The field is no longer editable.',
    };
  }

  const current = element.innerText ?? element.textContent ?? '';
  if (!current.includes(snapshot.selectedText)) {
    return {
      ok: false,
      reason: 'selection-mismatch',
      message: 'The selected text changed. Select it again to replace.',
    };
  }

  // Prefer Range around the live selection when it still matches.
  const selection = window.getSelection();
  if (
    selection &&
    selection.rangeCount > 0 &&
    !selection.isCollapsed &&
    element.contains(selection.anchorNode) &&
    selection.toString().replace(/\u00a0/g, ' ') === snapshot.selectedText
  ) {
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const textNode = document.createTextNode(replacement);
    range.insertNode(textNode);
    range.setStartAfter(textNode);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    dispatchEditableChangeEvents(element);
    element.focus();
    return { ok: true };
  }

  // Fallback: plain-text splice on innerText (loses rich markup in that host).
  const index = current.indexOf(snapshot.selectedText);
  if (index < 0) {
    return {
      ok: false,
      reason: 'selection-mismatch',
      message: 'The selected text changed. Select it again to replace.',
    };
  }

  const next =
    current.slice(0, index) + replacement + current.slice(index + snapshot.selectedText.length);
  element.innerText = next;
  dispatchEditableChangeEvents(element);
  element.focus();
  return { ok: true };
}
