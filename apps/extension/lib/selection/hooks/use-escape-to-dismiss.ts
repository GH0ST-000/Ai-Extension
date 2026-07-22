import { useEffect } from 'react';

import { useSelectionToolbarStore } from '../store';

/**
 * ESC closes the menu first, then the trigger — matches Raycast-like dismissal.
 */
export function useEscapeToDismiss(): void {
  const phase = useSelectionToolbarStore((s) => s.phase);
  const closeMenu = useSelectionToolbarStore((s) => s.closeMenu);
  const dismiss = useSelectionToolbarStore((s) => s.dismiss);

  useEffect(() => {
    if (phase === 'hidden') {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      if (phase === 'menu') {
        closeMenu();
        return;
      }

      dismiss();
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [closeMenu, dismiss, phase]);
}
