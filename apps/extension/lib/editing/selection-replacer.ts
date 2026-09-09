import type { EditableSelectionSnapshot, ReplacementResult } from './editing.types';
import { replaceContentEditableSelection } from './strategies/contenteditable-replacement.strategy';
import {
  replaceInputSelection,
  replaceTextareaSelection,
} from './strategies/input-replacement.strategy';

const MAX_REPLACEMENT_CHARS = 100_000;

/**
 * Validate then apply an in-place replacement using the captured snapshot.
 */
export function replaceEditableSelection(
  snapshot: EditableSelectionSnapshot | null,
  replacement: string,
): ReplacementResult {
  if (!snapshot) {
    return {
      ok: false,
      reason: 'missing-snapshot',
      message: 'Nothing to replace. Select editable text again.',
    };
  }

  const next = replacement.replace(/\u00a0/g, ' ');
  if (!next.trim()) {
    return {
      ok: false,
      reason: 'empty-replacement',
      message: 'Replacement text is empty.',
    };
  }

  if (next.length > MAX_REPLACEMENT_CHARS) {
    return {
      ok: false,
      reason: 'unsupported',
      message: 'Replacement text is too large.',
    };
  }

  switch (snapshot.kind) {
    case 'input':
      return replaceInputSelection(snapshot, next);
    case 'textarea':
      return replaceTextareaSelection(snapshot, next);
    case 'contenteditable':
      return replaceContentEditableSelection(snapshot, next);
    default:
      return {
        ok: false,
        reason: 'not-editable',
        message: 'This selection cannot be replaced in place.',
      };
  }
}
