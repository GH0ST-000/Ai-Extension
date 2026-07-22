import { useEffect, useRef } from 'react';

import { useSelectionToolbarStore } from '../store';
import { isEventFromToolbar, readDomSelection } from '../utils/dom-selection';

const SELECTION_DEBOUNCE_MS = 16;

/**
 * Observes text selection on the host page and syncs the toolbar store.
 */
export function useTextSelection(): void {
  const showTrigger = useSelectionToolbarStore((s) => s.showTrigger);
  const updateAnchor = useSelectionToolbarStore((s) => s.updateAnchor);
  const dismiss = useSelectionToolbarStore((s) => s.dismiss);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    const clearTimer = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const syncAfterGesture = () => {
      const snapshot = readDomSelection();
      if (!snapshot) {
        if (useSelectionToolbarStore.getState().phase !== 'hidden') {
          dismiss();
        }
        return;
      }
      showTrigger(snapshot.text, snapshot.rect);
    };

    const scheduleGestureSync = () => {
      clearTimer();
      timerRef.current = window.setTimeout(syncAfterGesture, SELECTION_DEBOUNCE_MS);
    };

    const onMouseUp = (event: MouseEvent) => {
      if (isEventFromToolbar(event)) {
        return;
      }
      scheduleGestureSync();
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (isEventFromToolbar(event)) {
        return;
      }
      if (event.key === 'Shift' || event.key.startsWith('Arrow')) {
        scheduleGestureSync();
      }
    };

    const onSelectionChange = () => {
      clearTimer();
      timerRef.current = window.setTimeout(() => {
        const snapshot = readDomSelection();
        const { phase } = useSelectionToolbarStore.getState();

        if (!snapshot) {
          if (phase !== 'hidden') {
            dismiss();
          }
          return;
        }

        // Avoid flicker while dragging; mouseup owns first paint.
        if (phase === 'hidden') {
          return;
        }

        if (phase === 'menu') {
          updateAnchor(snapshot.rect);
          // If the selection text changed, fall back to trigger.
          showTrigger(snapshot.text, snapshot.rect);
          return;
        }

        showTrigger(snapshot.text, snapshot.rect);
      }, SELECTION_DEBOUNCE_MS);
    };

    const onScrollOrResize = () => {
      const snapshot = readDomSelection();
      if (!snapshot) {
        dismiss();
        return;
      }
      updateAnchor(snapshot.rect);
    };

    document.addEventListener('mouseup', onMouseUp, true);
    document.addEventListener('keyup', onKeyUp, true);
    document.addEventListener('selectionchange', onSelectionChange);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);

    return () => {
      clearTimer();
      document.removeEventListener('mouseup', onMouseUp, true);
      document.removeEventListener('keyup', onKeyUp, true);
      document.removeEventListener('selectionchange', onSelectionChange);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [dismiss, showTrigger, updateAnchor]);
}
