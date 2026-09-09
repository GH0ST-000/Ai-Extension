import type { EditableTarget, ReplaceableEditableTarget } from './editing.types';

const SUPPORTED_INPUT_TYPES = new Set([
  'text',
  'search',
  'email',
  'url',
  'tel',
  '', // missing type defaults to text
]);

const BLOCKED_INPUT_TYPES = new Set([
  'password',
  'file',
  'number',
  'range',
  'checkbox',
  'radio',
  'date',
  'time',
  'datetime-local',
  'month',
  'week',
  'color',
  'hidden',
  'submit',
  'button',
  'reset',
  'image',
]);

function isLockedFormControl(element: HTMLInputElement | HTMLTextAreaElement): boolean {
  return element.disabled || element.readOnly;
}

function isContentEditable(element: HTMLElement): boolean {
  const value = element.getAttribute('contenteditable');
  if (value === null) {
    return element.isContentEditable;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === '' || normalized === 'true' || normalized === 'plaintext-only';
}

/**
 * Classify a concrete DOM node as a replaceable editable target, or readonly.
 */
export function detectEditableTarget(node: Node | null): EditableTarget {
  if (!node) {
    return { type: 'readonly' };
  }

  const element =
    node instanceof Element
      ? node
      : node.parentElement instanceof Element
        ? node.parentElement
        : null;

  if (!element) {
    return { type: 'readonly' };
  }

  if (element instanceof HTMLTextAreaElement) {
    if (isLockedFormControl(element)) {
      return { type: 'readonly' };
    }
    return { type: 'textarea', element };
  }

  if (element instanceof HTMLInputElement) {
    const inputType = (element.type || 'text').toLowerCase();
    if (BLOCKED_INPUT_TYPES.has(inputType) || inputType === 'password') {
      return { type: 'readonly' };
    }
    if (!SUPPORTED_INPUT_TYPES.has(inputType)) {
      return { type: 'readonly' };
    }
    if (isLockedFormControl(element)) {
      return { type: 'readonly' };
    }
    return { type: 'input', element };
  }

  const editableHost = element.closest(
    '[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]',
  );

  if (editableHost instanceof HTMLElement && isContentEditable(editableHost)) {
    if (
      editableHost instanceof HTMLInputElement ||
      editableHost instanceof HTMLTextAreaElement ||
      editableHost.isContentEditable === false
    ) {
      return { type: 'readonly' };
    }
    return { type: 'contenteditable', element: editableHost };
  }

  return { type: 'readonly' };
}

export function isReplaceableTarget(target: EditableTarget): target is ReplaceableEditableTarget {
  return target.type === 'input' || target.type === 'textarea' || target.type === 'contenteditable';
}

/**
 * Resolve editable target from the current selection / active element.
 */
export function detectEditableTargetFromSelection(
  selection: Selection | null = typeof window !== 'undefined' ? window.getSelection() : null,
): EditableTarget {
  const active = typeof document !== 'undefined' ? document.activeElement : null;

  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    return detectEditableTarget(active);
  }

  if (active instanceof HTMLElement && active.isContentEditable) {
    return detectEditableTarget(active);
  }

  const anchor = selection?.anchorNode ?? null;
  return detectEditableTarget(anchor);
}
