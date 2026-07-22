import { useCallback, useEffect, useMemo } from 'react';
import { autoUpdate, flip, offset, shift, useFloating } from '@floating-ui/react';
import { AnimatePresence } from 'framer-motion';

import { dispatchAiAction } from '../actions';
import { AI_ACTIONS, MENU_OFFSET_PX, TRIGGER_OFFSET_PX } from '../constants';
import { useCompactTrigger } from '../hooks/use-compact-trigger';
import { useEscapeToDismiss } from '../hooks/use-escape-to-dismiss';
import { useOutsideClickToDismiss } from '../hooks/use-outside-click-to-dismiss';
import { useTextSelection } from '../hooks/use-text-selection';
import { useSelectionToolbarStore } from '../store';
import type { AiAction } from '../types';
import { createVirtualElement } from '../utils/dom-selection';
import { ActionMenu } from './action-menu';
import { FloatingTriggerButton } from './floating-trigger-button';

export function SelectionToolbar() {
  useTextSelection();
  useEscapeToDismiss();

  const phase = useSelectionToolbarStore((s) => s.phase);
  const anchorRect = useSelectionToolbarStore((s) => s.anchorRect);
  const selectedText = useSelectionToolbarStore((s) => s.selectedText);
  const openMenu = useSelectionToolbarStore((s) => s.openMenu);
  const dismiss = useSelectionToolbarStore((s) => s.dismiss);

  const compactTrigger = useCompactTrigger(anchorRect);

  useOutsideClickToDismiss(phase !== 'hidden');

  const virtualAnchor = useMemo(
    () => (anchorRect ? createVirtualElement(anchorRect) : null),
    [anchorRect],
  );

  const { refs, floatingStyles, update } = useFloating({
    open: phase !== 'hidden',
    placement: phase === 'menu' ? 'bottom-start' : 'top',
    strategy: 'fixed',
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(phase === 'menu' ? MENU_OFFSET_PX : TRIGGER_OFFSET_PX),
      flip({
        padding: 12,
        fallbackPlacements: ['top-start', 'bottom', 'top', 'right-start', 'left-start'],
      }),
      shift({ padding: 12 }),
    ],
  });

  useEffect(() => {
    if (!virtualAnchor) {
      refs.setReference(null);
      return;
    }
    refs.setReference(virtualAnchor);
    void update();
  }, [refs, update, virtualAnchor]);

  const handleAction = useCallback(
    (action: AiAction) => {
      dispatchAiAction(action.id, selectedText);
      dismiss();
    },
    [dismiss, selectedText],
  );

  useEffect(() => {
    if (phase !== 'menu') {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }

      const action = AI_ACTIONS.find(
        (item) => item.shortcut?.toLowerCase() === event.key.toLowerCase(),
      );
      if (!action) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      handleAction(action);
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [handleAction, phase]);

  const visible = phase !== 'hidden' && Boolean(anchorRect);

  return (
    <div className="pointer-events-none fixed inset-0 z-[2147483646]">
      {visible ? (
        <div ref={refs.setFloating} style={floatingStyles} className="pointer-events-auto">
          <AnimatePresence mode="wait">
            {phase === 'trigger' ? (
              <FloatingTriggerButton key="trigger" compact={compactTrigger} onOpen={openMenu} />
            ) : null}
            {phase === 'menu' ? <ActionMenu key="menu" onSelect={handleAction} /> : null}
          </AnimatePresence>
        </div>
      ) : null}
    </div>
  );
}
