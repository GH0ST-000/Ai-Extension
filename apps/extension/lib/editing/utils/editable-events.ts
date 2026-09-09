/**
 * Fire the events frameworks and native listeners expect after a programmatic edit.
 */
export function dispatchEditableChangeEvents(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLElement,
): void {
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}
