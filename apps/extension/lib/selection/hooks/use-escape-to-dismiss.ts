import { useEffect } from 'react';

import { useSelectionToolbarStore } from '../store';

/**
 * Esc closes nested assistant views first, then the trigger.
 */
export function useEscapeToDismiss(): void {
  const phase = useSelectionToolbarStore((s) => s.phase);
  const assistant = useSelectionToolbarStore((s) => s.assistant);
  const closeMenu = useSelectionToolbarStore((s) => s.closeMenu);
  const backToMenu = useSelectionToolbarStore((s) => s.backToMenu);
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

      if (phase === 'assistant') {
        if (assistant.status === 'menu') {
          closeMenu();
          return;
        }
        if (
          assistant.status === 'custom-prompt' ||
          assistant.status === 'loading' ||
          assistant.status === 'streaming' ||
          assistant.status === 'success' ||
          assistant.status === 'error'
        ) {
          backToMenu();
          return;
        }
      }

      dismiss();
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [assistant, backToMenu, closeMenu, dismiss, phase]);
}
