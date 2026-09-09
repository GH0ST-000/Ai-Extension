/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  captureEditableSelectionSnapshot,
  detectEditableTarget,
  replaceEditableSelection,
} from './index';

describe('detectEditableTarget', () => {
  it('accepts text inputs and textareas', () => {
    const input = document.createElement('input');
    input.type = 'text';
    expect(detectEditableTarget(input).type).toBe('input');

    const area = document.createElement('textarea');
    expect(detectEditableTarget(area).type).toBe('textarea');
  });

  it('rejects password and disabled fields', () => {
    const password = document.createElement('input');
    password.type = 'password';
    expect(detectEditableTarget(password).type).toBe('readonly');

    const locked = document.createElement('textarea');
    locked.disabled = true;
    expect(detectEditableTarget(locked).type).toBe('readonly');
  });

  it('detects contenteditable hosts', () => {
    const div = document.createElement('div');
    div.setAttribute('contenteditable', 'true');
    document.body.appendChild(div);
    expect(detectEditableTarget(div).type).toBe('contenteditable');
    div.remove();
  });
});

describe('capture + replace editable selection', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('replaces selected text inside a textarea', () => {
    const area = document.createElement('textarea');
    area.value = 'Hello world today';
    document.body.appendChild(area);
    area.focus();
    area.setSelectionRange(6, 11); // "world"

    const snapshot = captureEditableSelectionSnapshot('world');
    expect(snapshot?.kind).toBe('textarea');
    expect(snapshot?.start).toBe(6);
    expect(snapshot?.end).toBe(11);

    const result = replaceEditableSelection(snapshot, 'universe');
    expect(result).toEqual({ ok: true });
    expect(area.value).toBe('Hello universe today');
  });

  it('replaces selected text inside a text input', () => {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = 'ship it now';
    document.body.appendChild(input);
    input.focus();
    input.setSelectionRange(0, 4);

    const snapshot = captureEditableSelectionSnapshot('ship');
    const result = replaceEditableSelection(snapshot, 'send');
    expect(result.ok).toBe(true);
    expect(input.value).toBe('send it now');
  });

  it('does not replace when snapshot is missing', () => {
    expect(replaceEditableSelection(null, 'x')).toMatchObject({
      ok: false,
      reason: 'missing-snapshot',
    });
  });
});
