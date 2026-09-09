import { detectEditableTargetFromSelection, isReplaceableTarget } from './editable-target.detector';
import type { EditableSelectionSnapshot } from './editing.types';

function normalizeSelectedText(text: string): string {
  return text.replace(/\u00a0/g, ' ');
}

/**
 * Capture editable selection details before focus moves to the toolbar.
 */
export function captureEditableSelectionSnapshot(
  selectedText: string,
): EditableSelectionSnapshot | null {
  const trimmed = normalizeSelectedText(selectedText).trim();
  if (!trimmed) {
    return null;
  }

  const selection = window.getSelection();
  const target = detectEditableTargetFromSelection(selection);
  if (!isReplaceableTarget(target)) {
    return null;
  }

  if (target.type === 'input' || target.type === 'textarea') {
    const element = target.element;
    const start = element.selectionStart;
    const end = element.selectionEnd;
    if (start === null || end === null || start === end) {
      return null;
    }

    const slice = element.value.slice(start, end);
    const normalizedSlice = normalizeSelectedText(slice).trim();
    if (
      normalizedSlice !== trimmed &&
      normalizeSelectedText(slice) !== normalizeSelectedText(selectedText)
    ) {
      // Allow minor trim differences between store text and raw slice.
      if (!normalizeSelectedText(slice).includes(trimmed) && !trimmed.includes(normalizedSlice)) {
        return null;
      }
    }

    return {
      kind: target.type,
      element,
      selectedText: slice,
      fullText: element.value,
      start,
      end,
      capturedAt: Date.now(),
    };
  }

  // contenteditable
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }

  if (!target.element.contains(selection.anchorNode)) {
    return null;
  }

  const raw = normalizeSelectedText(selection.toString());
  if (!raw.trim()) {
    return null;
  }

  const fullText = target.element.innerText ?? target.element.textContent ?? '';
  const start = fullText.indexOf(raw);
  const end = start >= 0 ? start + raw.length : raw.length;

  return {
    kind: 'contenteditable',
    element: target.element,
    selectedText: raw,
    fullText,
    start: Math.max(0, start),
    end: Math.max(0, end),
    capturedAt: Date.now(),
  };
}

export function snapshotSupportsReplace(
  snapshot: EditableSelectionSnapshot | null,
): snapshot is EditableSelectionSnapshot {
  return snapshot !== null;
}
