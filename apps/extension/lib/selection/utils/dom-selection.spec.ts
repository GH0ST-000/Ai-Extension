/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';

import { getFormControlSelectionRect, readDomSelection } from './dom-selection';

describe('getFormControlSelectionRect', () => {
  it('returns a rect inside the textarea instead of only the full control box', () => {
    const textarea = document.createElement('textarea');
    textarea.value = ['line one', 'line two selected here', 'line three'].join('\n');
    textarea.style.position = 'fixed';
    textarea.style.top = '100px';
    textarea.style.left = '50px';
    textarea.style.width = '400px';
    textarea.style.height = '300px';
    textarea.style.font = '14px monospace';
    textarea.style.lineHeight = '20px';
    textarea.style.padding = '0';
    textarea.style.border = '0';
    textarea.style.whiteSpace = 'pre-wrap';
    document.body.appendChild(textarea);

    textarea.getBoundingClientRect = () =>
      ({
        x: 50,
        y: 100,
        width: 400,
        height: 300,
        top: 100,
        left: 50,
        right: 450,
        bottom: 400,
        toJSON() {
          return {};
        },
      }) as DOMRect;

    Object.defineProperty(textarea, 'clientWidth', { value: 400 });
    Object.defineProperty(textarea, 'scrollTop', { value: 0, writable: true });
    Object.defineProperty(textarea, 'scrollLeft', { value: 0, writable: true });

    const start = textarea.value.indexOf('line two');
    const end = start + 'line two selected here'.length;
    const rect = getFormControlSelectionRect(textarea, start, end);

    expect(rect).not.toBeNull();
    // Must not collapse to the entire 300px-tall textarea top edge only.
    expect(rect!.top).toBeGreaterThanOrEqual(100);
    expect(rect!.top).toBeLessThan(400);
    expect(rect!.height).toBeLessThan(300);

    textarea.remove();
  });
});

describe('readDomSelection', () => {
  it('reads textarea selection via activeElement when window selection is empty', () => {
    const textarea = document.createElement('textarea');
    textarea.value = 'hello world from github blob';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.setSelectionRange(6, 11);

    textarea.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        width: 200,
        height: 40,
        top: 0,
        left: 0,
        right: 200,
        bottom: 40,
        toJSON() {
          return {};
        },
      }) as DOMRect;
    Object.defineProperty(textarea, 'clientWidth', { value: 200 });

    const snapshot = readDomSelection();
    expect(snapshot?.text).toBe('world');

    textarea.remove();
  });
});
