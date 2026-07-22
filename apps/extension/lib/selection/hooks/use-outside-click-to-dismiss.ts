import { useEffect } from 'react';

import { useSelectionToolbarStore } from '../store';
import { isEventFromToolbar } from '../utils/dom-selection';

/**
 * Pointer down outside the toolbar dismisses the entire interaction layer.
 */
export function useOutsideClickToDismiss(enabled: boolean): void {
  const dismiss = useSelectionToolbarStore((s) => s.dismiss);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const onPointerDown = (event: PointerEvent) => {
      if (isEventFromToolbar(event)) {
        return;
      }
      dismiss();
    };

    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [dismiss, enabled]);
}
