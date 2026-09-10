import { useCallback, useEffect, useMemo, useState } from 'react';
import { autoUpdate, flip, offset, shift, useFloating } from '@floating-ui/react';
import { AnimatePresence } from 'framer-motion';
import { AIAction, type PRReviewFinding } from '@project-x/types';

import {
  AI_ACTIONS,
  DIAGNOSTIC_AI_ACTIONS,
  MENU_OFFSET_PX,
  TRIGGER_OFFSET_PX,
  actionFromShortcut,
  getActionDefinition,
} from '../constants';
import { useCompactTrigger } from '../hooks/use-compact-trigger';
import { useEscapeToDismiss } from '../hooks/use-escape-to-dismiss';
import { useOutsideClickToDismiss } from '../hooks/use-outside-click-to-dismiss';
import { useTextSelection } from '../hooks/use-text-selection';
import { getRankedActions, sniffRankingHints } from '../smart-actions';
import {
  getGithubConnection,
  GithubApiError,
  postPullRequestComment,
} from '../../services/github-api';
import { useSelectionToolbarStore } from '../store';
import type { AiActionDefinition } from '../types';
import { buildPrReviewReport } from '../utils/build-pr-review-report';
import { createVirtualElement } from '../utils/dom-selection';
import {
  buildPrReviewCommentDraft,
  buildPrReviewHandoffSummary,
  formatPrReviewMarkdown,
} from '../utils/format-pr-review-markdown';
import { extractFixClipboardText } from '../utils/parse-suggest-fix';
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
  const selectedText = useSelectionToolbarStore((s) => s.selectedText);
  const assistant = useSelectionToolbarStore((s) => s.assistant);
  const customPrompt = useSelectionToolbarStore((s) => s.customPrompt);
  const lastReviewContext = useSelectionToolbarStore((s) => s.lastReviewContext);
  const findingFilter = useSelectionToolbarStore((s) => s.findingFilter);
  const findingDispositions = useSelectionToolbarStore((s) => s.findingDispositions);
  const openMenu = useSelectionToolbarStore((s) => s.openMenu);
  const dismiss = useSelectionToolbarStore((s) => s.dismiss);
  const openCustomPrompt = useSelectionToolbarStore((s) => s.openCustomPrompt);
  const setCustomPromptInput = useSelectionToolbarStore((s) => s.setCustomPromptInput);
  const backToMenu = useSelectionToolbarStore((s) => s.backToMenu);
  const startAction = useSelectionToolbarStore((s) => s.startAction);
  const retry = useSelectionToolbarStore((s) => s.retry);
  const replaceSelection = useSelectionToolbarStore((s) => s.replaceSelection);
  const setFindingFilter = useSelectionToolbarStore((s) => s.setFindingFilter);
  const setFindingDisposition = useSelectionToolbarStore((s) => s.setFindingDisposition);
  const editableSnapshot = useSelectionToolbarStore((s) => s.editableSnapshot);
  const canReplace = Boolean(editableSnapshot);
  const [githubConnected, setGithubConnected] = useState<boolean | null>(null);

  const rankedActions = useMemo(() => {
    if (!selectedText.trim()) {
      return AI_ACTIONS;
    }
    return getRankedActions(selectedText, sniffRankingHints()).actions;
  }, [selectedText]);

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

  const handleCopyFix = useCallback(async () => {
    if (assistant.status !== 'success' && assistant.status !== 'streaming') {
      return false;
    }
    try {
      await navigator.clipboard.writeText(extractFixClipboardText(assistant.content));
      return true;
    } catch {
      return false;
    }
  }, [assistant]);

  const handleSuggestFix = useCallback(() => {
    if (assistant.status !== 'success' || assistant.action !== AIAction.REVIEW_CODE) {
      return;
    }
    void startAction(AIAction.SUGGEST_FIX, {
      customPrompt: `Prior review findings:\n${assistant.content.trim()}`,
    });
  }, [assistant, startAction]);

  const handleSuggestFixForFinding = useCallback(
    (finding: PRReviewFinding) => {
      if (assistant.status !== 'success' || assistant.action !== AIAction.REVIEW_ENTIRE_PR) {
        return;
      }
      const focus = finding.filePath ? `File: ${finding.filePath}\n` : '';
      void startAction(AIAction.SUGGEST_FIX, {
        customPrompt: `Prior PR finding to fix:\n${focus}${finding.raw}`,
      });
    },
    [assistant, startAction],
  );

  const getCurrentPrReport = useCallback(() => {
    if (
      (assistant.status !== 'success' && assistant.status !== 'streaming') ||
      assistant.action !== AIAction.REVIEW_ENTIRE_PR
    ) {
      return null;
    }
    return buildPrReviewReport({
      markdown: assistant.content,
      context: lastReviewContext,
    });
  }, [assistant, lastReviewContext]);

  const handleCopyFullReview = useCallback(async () => {
    const report = getCurrentPrReport();
    if (!report) {
      return false;
    }
    try {
      await navigator.clipboard.writeText(
        formatPrReviewMarkdown(report, {
          dispositions: findingDispositions,
        }),
      );
      return true;
    } catch {
      return false;
    }
  }, [getCurrentPrReport, findingDispositions]);

  const handleCopySummary = useCallback(async () => {
    const report = getCurrentPrReport();
    if (!report) {
      return false;
    }
    try {
      await navigator.clipboard.writeText(buildPrReviewHandoffSummary(report, findingDispositions));
      return true;
    } catch {
      return false;
    }
  }, [getCurrentPrReport, findingDispositions]);

  const handleCopyCommentDraft = useCallback(async () => {
    const report = getCurrentPrReport();
    if (!report) {
      return false;
    }
    try {
      await navigator.clipboard.writeText(buildPrReviewCommentDraft(report, findingDispositions));
      return true;
    } catch {
      return false;
    }
  }, [getCurrentPrReport, findingDispositions]);

  useEffect(() => {
    const isPrResult =
      (assistant.status === 'success' || assistant.status === 'streaming') &&
      assistant.action === AIAction.REVIEW_ENTIRE_PR;

    if (!isPrResult) {
      setGithubConnected(null);
      return;
    }

    let cancelled = false;
    void getGithubConnection()
      .then((status) => {
        if (!cancelled) {
          setGithubConnected(status.connected);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setGithubConnected(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [assistant]);

  const handlePostComment = useCallback(
    async (body: string) => {
      const report = getCurrentPrReport();
      if (!report) {
        return { ok: false as const, message: 'Review report is unavailable.' };
      }

      // Same PR + same body → same key (safe double-click). Edited body → new post.
      const bodyKey = Array.from(body)
        .reduce((hash, char) => ((hash << 5) - hash + char.charCodeAt(0)) | 0, 0)
        .toString(36)
        .replace(/^-/, 'n');
      const idempotencyKey =
        `pr-${report.repository.owner}-${report.repository.name}-${report.pullRequest.number}-${bodyKey}`.slice(
          0,
          128,
        );

      try {
        const result = await postPullRequestComment({
          owner: report.repository.owner,
          repository: report.repository.name,
          pullRequestNumber: report.pullRequest.number,
          body,
          idempotencyKey,
        });
        return {
          ok: true as const,
          message: result.deduplicated
            ? 'Already posted (same request).'
            : 'Comment posted to GitHub.',
          commentUrl: result.commentUrl,
        };
      } catch (error) {
        const message =
          error instanceof GithubApiError ? error.message : 'Unable to post comment to GitHub.';
        return { ok: false as const, message };
      }
    },
    [getCurrentPrReport],
  );

  useEffect(() => {
    if (!assistantOpen || assistant.status !== 'menu') {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }

      // Bind by AIAction identity — never by ranked menu index.
      const actionId = actionFromShortcut(event.key);
      if (!actionId) {
        return;
      }

      const action = getActionDefinition(actionId);
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
              <ActionMenu key="menu" actions={rankedActions} onSelect={handleSelectAction} />
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
                canReplace={
                  canReplace &&
                  assistant.status === 'success' &&
                  !DIAGNOSTIC_AI_ACTIONS.has(assistant.action)
                }
                reviewContext={
                  assistant.action === AIAction.REVIEW_ENTIRE_PR ? lastReviewContext : null
                }
                findingFilter={findingFilter}
                findingDispositions={findingDispositions}
                onCopy={handleCopy}
                onCopyFix={assistant.action === AIAction.SUGGEST_FIX ? handleCopyFix : undefined}
                onCopyFullReview={
                  assistant.action === AIAction.REVIEW_ENTIRE_PR ? handleCopyFullReview : undefined
                }
                onCopySummary={
                  assistant.action === AIAction.REVIEW_ENTIRE_PR ? handleCopySummary : undefined
                }
                onCopyCommentDraft={
                  assistant.action === AIAction.REVIEW_ENTIRE_PR
                    ? handleCopyCommentDraft
                    : undefined
                }
                onPostComment={
                  assistant.action === AIAction.REVIEW_ENTIRE_PR && assistant.status === 'success'
                    ? handlePostComment
                    : undefined
                }
                githubConnected={
                  assistant.action === AIAction.REVIEW_ENTIRE_PR ? githubConnected : null
                }
                onSuggestFix={
                  assistant.action === AIAction.REVIEW_CODE && assistant.status === 'success'
                    ? handleSuggestFix
                    : undefined
                }
                onSuggestFixForFinding={
                  assistant.action === AIAction.REVIEW_ENTIRE_PR && assistant.status === 'success'
                    ? handleSuggestFixForFinding
                    : undefined
                }
                onFindingFilterChange={setFindingFilter}
                onSetFindingDisposition={setFindingDisposition}
                onReplace={() => {
                  const result = replaceSelection();
                  return {
                    ok: result.ok,
                    message: result.ok ? undefined : result.message,
                  };
                }}
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
