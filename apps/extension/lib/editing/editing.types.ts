export type EditableKind = 'input' | 'textarea' | 'contenteditable';

export type EditableTarget =
  | {
      type: 'input';
      element: HTMLInputElement;
    }
  | {
      type: 'textarea';
      element: HTMLTextAreaElement;
    }
  | {
      type: 'contenteditable';
      element: HTMLElement;
    }
  | {
      type: 'readonly';
    };

export type ReplaceableEditableTarget = Exclude<EditableTarget, { type: 'readonly' }>;

/**
 * Snapshot of an editable selection captured before focus leaves the field.
 * Indices are UTF-16 code units (DOM string indices).
 */
export type EditableSelectionSnapshot = {
  kind: EditableKind;
  /** Weak identity via element reference (same document lifetime). */
  element: HTMLInputElement | HTMLTextAreaElement | HTMLElement;
  selectedText: string;
  /** Full field value / textContent at capture time (for validation). */
  fullText: string;
  start: number;
  end: number;
  capturedAt: number;
};

export type ReplacementResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'not-editable'
        | 'missing-snapshot'
        | 'element-detached'
        | 'element-locked'
        | 'selection-mismatch'
        | 'empty-replacement'
        | 'unsupported';
      message: string;
    };
