import type { EditableSelectionSnapshot, ReplacementResult } from '../editing.types';
import { dispatchEditableChangeEvents } from '../utils/editable-events';
import { setNativeInputValue } from '../utils/native-value-setter';

function ensureLiveInput(
  snapshot: EditableSelectionSnapshot,
): { element: HTMLInputElement | HTMLTextAreaElement } | ReplacementResult {
  const el = snapshot.element;
  if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) {
    return {
      ok: false,
      reason: 'unsupported',
      message: 'Expected an input or textarea.',
    };
  }
  if (!el.isConnected) {
    return {
      ok: false,
      reason: 'element-detached',
      message: 'The field is no longer on the page.',
    };
  }
  if (el.disabled || el.readOnly) {
    return {
      ok: false,
      reason: 'element-locked',
      message: 'The field is no longer editable.',
    };
  }
  return { element: el };
}

function replaceInValueControl(
  snapshot: EditableSelectionSnapshot,
  replacement: string,
): ReplacementResult {
  const live = ensureLiveInput(snapshot);
  if ('ok' in live) {
    return live;
  }
  const { element } = live;

  const current = element.value;
  const slice = current.slice(snapshot.start, snapshot.end);
  if (slice !== snapshot.selectedText) {
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
    setNativeInputValue(element, next);
    const caret = index + replacement.length;
    element.setSelectionRange(caret, caret);
    dispatchEditableChangeEvents(element);
    element.focus();
    return { ok: true };
  }

  const next = current.slice(0, snapshot.start) + replacement + current.slice(snapshot.end);
  setNativeInputValue(element, next);
  const caret = snapshot.start + replacement.length;
  element.setSelectionRange(caret, caret);
  dispatchEditableChangeEvents(element);
  element.focus();
  return { ok: true };
}

export function replaceInputSelection(
  snapshot: EditableSelectionSnapshot,
  replacement: string,
): ReplacementResult {
  if (snapshot.kind !== 'input') {
    return { ok: false, reason: 'unsupported', message: 'Not an input snapshot.' };
  }
  return replaceInValueControl(snapshot, replacement);
}

export function replaceTextareaSelection(
  snapshot: EditableSelectionSnapshot,
  replacement: string,
): ReplacementResult {
  if (snapshot.kind !== 'textarea') {
    return { ok: false, reason: 'unsupported', message: 'Not a textarea snapshot.' };
  }
  return replaceInValueControl(snapshot, replacement);
}
