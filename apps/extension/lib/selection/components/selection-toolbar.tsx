import { useCallback, useEffect, useMemo } from 'react';
import { autoUpdate, flip, offset, shift, useFloating } from '@floating-ui/react';
import { AnimatePresence } from 'framer-motion';
import { AIAction } from '@project-x/types';

import { AI_ACTIONS, MENU_OFFSET_PX, TRIGGER_OFFSET_PX } from '../constants';
import { useCompactTrigger } from '../hooks/use-compact-trigger';
import { useEscapeToDismiss } from '../hooks/use-escape-to-dismiss';
import { useOutsideClickToDismiss } from '../hooks/use-outside-click-to-dismiss';
import { useTextSelection } from '../hooks/use-text-selection';
import { useSelectionToolbarStore } from '../store';
import type { AiActionDefinition } from '../types';
import { createVirtualElement } from '../utils/dom-selection';
import { ActionMenu } from './action-menu';
import { CustomPromptPanel } from './custom-prompt-panel';
import { ErrorPanel } from './error-panel';
import { FloatingTriggerButton } from './floating-trigger-button';
import { LoadingPanel } from './loading-panel';
import { ResultPanel } from './result-panel';

export function SelectionToolbar() {
  useTextSelection();
  useEscapeToDismiss();

  const phase = useSelectionToolbarStore((s) => s.phase);
  const anchorRect = useSelectionToolbarStore((s) => s.anchorRect);
  const assistant = useSelectionToolbarStore((s) => s.assistant);
  const customPrompt = useSelectionToolbarStore((s) => s.customPrompt);
  const openMenu = useSelectionToolbarStore((s) => s.openMenu);
  const dismiss = useSelectionToolbarStore((s) => s.dismiss);
  const openCustomPrompt = useSelectionToolbarStore((s) => s.openCustomPrompt);
  const setCustomPromptInput = useSelectionToolbarStore((s) => s.setCustomPromptInput);
  const backToMenu = useSelectionToolbarStore((s) => s.backToMenu);
  const startAction = useSelectionToolbarStore((s) => s.startAction);
  const retry = useSelectionToolbarStore((s) => s.retry);

  const compactTrigger = useCompactTrigger(anchorRect);
  const assistantOpen = phase === 'assistant';
  useOutsideClickToDismiss(phase !== 'hidden');

  const virtualAnchor = useMemo(
    () => (anchorRect ? createVirtualElement(anchorRect) : null),
    [anchorRect],
  );

  const { refs, floatingStyles, update } = useFloating({
    open: phase !== 'hidden',
    placement: assistantOpen ? 'bottom-start' : 'top',
    strategy: 'fixed',
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(assistantOpen ? MENU_OFFSET_PX : TRIGGER_OFFSET_PX),
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

  const handleSelectAction = useCallback(
    (action: AiActionDefinition) => {
      if (action.id === AIAction.CUSTOM) {
        openCustomPrompt();
        return;
      }
      void startAction(action.id);
    },
    [openCustomPrompt, startAction],
  );

  const handleCopy = useCallback(async () => {
    if (assistant.status !== 'success' && assistant.status !== 'streaming') {
      return false;
    }
    try {
      await navigator.clipboard.writeText(assistant.content);
      return true;
    } catch {
      return false;
    }
  }, [assistant]);

  useEffect(() => {
    if (!assistantOpen || assistant.status !== 'menu') {
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
      handleSelectAction(action);
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [assistant.status, assistantOpen, handleSelectAction]);

  const visible = phase !== 'hidden' && Boolean(anchorRect);

  return (
    <div className="pointer-events-none fixed inset-0 z-[2147483646]">
      {visible ? (
        <div ref={refs.setFloating} style={floatingStyles} className="pointer-events-auto">
          <AnimatePresence mode="wait">
            {phase === 'trigger' ? (
              <FloatingTriggerButton key="trigger" compact={compactTrigger} onOpen={openMenu} />
            ) : null}

            {phase === 'assistant' && assistant.status === 'menu' ? (
              <ActionMenu key="menu" onSelect={handleSelectAction} />
            ) : null}

            {phase === 'assistant' && assistant.status === 'custom-prompt' ? (
              <CustomPromptPanel
                key="custom-prompt"
                value={customPrompt}
                onChange={setCustomPromptInput}
                onSubmit={() => {
                  void startAction(AIAction.CUSTOM, { customPrompt });
                }}
                onBack={backToMenu}
                onClose={dismiss}
              />
            ) : null}

            {phase === 'assistant' && assistant.status === 'loading' ? (
              <LoadingPanel key="loading" action={assistant.action} onClose={dismiss} />
            ) : null}

            {phase === 'assistant' &&
            (assistant.status === 'streaming' || assistant.status === 'success') ? (
              <ResultPanel
                key="result"
                action={assistant.action}
                content={assistant.content}
                streaming={assistant.status === 'streaming'}
                onCopy={handleCopy}
                onRetry={() => {
                  void retry();
                }}
                onBack={backToMenu}
                onClose={dismiss}
              />
            ) : null}

            {phase === 'assistant' && assistant.status === 'error' ? (
              <ErrorPanel
                key="error"
                action={assistant.action}
                message={assistant.message}
                onRetry={() => {
                  void retry();
                }}
                onBack={backToMenu}
                onClose={dismiss}
              />
            ) : null}
          </AnimatePresence>
        </div>
      ) : null}
    </div>
  );
}
