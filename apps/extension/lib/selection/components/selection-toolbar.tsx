import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { useDocumentHref } from '../hooks/use-document-href';
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
import { CiEntryButton, CiPanel, useGithubCiStore } from '../ci';
import { JiraIssuePanel, useJiraSessionStore } from '../jira';
import {
  OpenApiPanel,
  PrOpenApiChangesButton,
  buildCompareApiWithJiraText,
  useOpenApiSessionStore,
} from '../openapi';
import { extractPageContext } from '../../context/extract-page-context';
import { parseGitHubUrl } from '../../context/adapters/github.adapter';
import { detectJiraKeysInPrSignals } from '@project-x/shared';
import { buildJiraIssuePromptText } from '../jira/jira.store';

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
  const suggestFixApplyTarget = useSelectionToolbarStore((s) => s.suggestFixApplyTarget);
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
  const ciView = useGithubCiStore((s) => s.view);
  const openCi = useGithubCiStore((s) => s.open);

  const documentHref = useDocumentHref();

  const pageSnapshot = useMemo(() => {
    // Refresh when SPA URL or menu/selection changes (extract reads live DOM/URL).
    void documentHref;
    void phase;
    void selectedText;
    if (typeof window === 'undefined') {
      return null;
    }
    try {
      return extractPageContext();
    } catch {
      return null;
    }
  }, [phase, selectedText, documentHref]);

  const jiraIssueKey = pageSnapshot?.type === 'jira' ? pageSnapshot.jira?.issueKey : undefined;
  const jiraHost = pageSnapshot?.type === 'jira' ? pageSnapshot.jira?.siteHost : undefined;
  const sessionJiraIssue = useJiraSessionStore((s) => s.issue);
  /** Prefer live page issue; keep session issue when browsing API/GitHub for Day 17/18 bridge. */
  const effectiveJiraKey = jiraIssueKey ?? sessionJiraIssue?.key;
  const effectiveJiraHost = jiraHost ?? sessionJiraIssue?.siteHost;

  const openApiContext = pageSnapshot?.type === 'openapi' ? pageSnapshot.openapi : undefined;
  const openApiDocumentUrl = openApiContext?.documentUrl;
  const openApiOperationKey = openApiContext?.selectedOperation
    ? `${openApiContext.selectedOperation.method}:${openApiContext.selectedOperation.path}`
    : undefined;

  const githubJiraKeys = useMemo(() => {
    if (pageSnapshot?.type !== 'github' || !pageSnapshot.github) {
      return [] as string[];
    }
    const detected = detectJiraKeysInPrSignals({
      title: pageSnapshot.github.pullRequestTitle,
      body: pageSnapshot.github.pullRequestBody,
      headBranch: pageSnapshot.github.headBranch,
    });
    return detected.map((d) => d.issueKey);
  }, [pageSnapshot]);

  const clearJira = useJiraSessionStore((s) => s.clearIssue);
  const clearOpenApi = useOpenApiSessionStore((s) => s.clear);
  const markComparison = useJiraSessionStore((s) => s.markComparison);
  const comparisonStale = useJiraSessionStore((s) => s.isComparisonStale);
  const ciSummary = useGithubCiStore((s) => s.summary);
  const prevJiraNavRef = useRef<{ key?: string; host?: string } | null>(null);
  const prevOpenApiNavRef = useRef<{ documentUrl?: string; operationKey?: string } | null>(null);

  useEffect(() => {
    const prev = prevJiraNavRef.current;
    // Only invalidate when switching between two concrete Jira issues — keep session
    // when leaving Jira for OpenAPI/GitHub so Compare still works.
    if (prev?.key && jiraIssueKey && (prev.key !== jiraIssueKey || prev.host !== jiraHost)) {
      clearJira();
    }
    prevJiraNavRef.current = { key: jiraIssueKey, host: jiraHost };
  }, [jiraIssueKey, jiraHost, clearJira]);

  useEffect(() => {
    const prev = prevOpenApiNavRef.current;
    if (
      prev &&
      (prev.documentUrl !== openApiDocumentUrl || prev.operationKey !== openApiOperationKey)
    ) {
      clearOpenApi();
    }
    prevOpenApiNavRef.current = {
      documentUrl: openApiDocumentUrl,
      operationKey: openApiOperationKey,
    };
  }, [openApiDocumentUrl, openApiOperationKey, clearOpenApi]);

  const prCiDestination = useMemo(() => {
    const fromReview = lastReviewContext?.github;
    const fromPage = pageSnapshot?.type === 'github' ? pageSnapshot.github : undefined;

    if (
      fromReview?.owner &&
      fromReview.repository &&
      fromReview.pullRequestNumber &&
      fromReview.pullRequestNumber > 0
    ) {
      return {
        owner: fromReview.owner,
        repository: fromReview.repository,
        pullRequestNumber: fromReview.pullRequestNumber,
        pullRequestTitle: fromReview.pullRequestTitle,
        // Prefer live Files-tab DOM list when present; fall back to review session.
        changedFiles: fromPage?.changedFiles?.length
          ? fromPage.changedFiles
          : fromReview.changedFiles,
      };
    }

    if (
      fromPage?.owner &&
      fromPage.repository &&
      fromPage.pullRequestNumber &&
      fromPage.pullRequestNumber > 0
    ) {
      return {
        owner: fromPage.owner,
        repository: fromPage.repository,
        pullRequestNumber: fromPage.pullRequestNumber,
        pullRequestTitle: fromPage.pullRequestTitle,
        changedFiles: fromPage.changedFiles,
      };
    }

    if (typeof window === 'undefined') {
      return null;
    }
    try {
      const parsed = parseGitHubUrl(new URL(window.location.href));
      if (
        parsed?.owner &&
        parsed.repository &&
        parsed.isPullRequest &&
        parsed.pullRequestNumber &&
        parsed.pullRequestNumber > 0
      ) {
        return {
          owner: parsed.owner,
          repository: parsed.repository,
          pullRequestNumber: parsed.pullRequestNumber,
          pullRequestTitle: fromPage?.pullRequestTitle,
          changedFiles: fromPage?.changedFiles,
        };
      }
    } catch {
      // ignore
    }
    return null;
  }, [lastReviewContext, pageSnapshot]);

  const handleOpenCi = useCallback(() => {
    if (!prCiDestination) {
      return;
    }
    openCi(prCiDestination);
  }, [openCi, prCiDestination]);

  const comparisonHeadToken =
    ciSummary?.headSha ??
    (lastReviewContext?.github || pageSnapshot?.github
      ? [
          lastReviewContext?.github?.owner ?? pageSnapshot?.github?.owner,
          lastReviewContext?.github?.repository ?? pageSnapshot?.github?.repository,
          lastReviewContext?.github?.pullRequestNumber ?? pageSnapshot?.github?.pullRequestNumber,
          lastReviewContext?.github?.headBranch ?? pageSnapshot?.github?.headBranch,
        ]
          .filter(Boolean)
          .join('/')
      : null);

  const handleCompareJiraWithPr = useCallback(() => {
    const issue = useJiraSessionStore.getState().issue;
    const review = lastReviewContext ?? pageSnapshot;
    if (!issue) {
      return;
    }
    const github = review?.github;
    const truncatedNote = github?.changedFilesTruncated
      ? `Comparison is based on a partial PR analysis: ${github.changedFiles?.length ?? 0} files included (truncated).`
      : null;
    const headToken =
      ciSummary?.headSha ??
      [
        github?.owner,
        github?.repository,
        github?.pullRequestNumber,
        github?.headBranch ?? 'unknown-head',
      ]
        .filter(Boolean)
        .join('/');
    const prBits = github
      ? [
          `PR #${github.pullRequestNumber ?? '?'}`,
          github.pullRequestTitle,
          github.headBranch ? `headBranch: ${github.headBranch}` : null,
          ciSummary?.headSha ? `headSha: ${ciSummary.headSha}` : null,
          truncatedNote,
          ...(github.changedFiles ?? []).map((f) => `${f.path}\n${f.patchExcerpt ?? ''}`.trim()),
        ]
      : [];
    const text = [
      buildJiraIssuePromptText(issue),
      '---',
      'PR CONTEXT (untrusted):',
      ...prBits.filter(Boolean),
    ]
      .join('\n\n')
      .slice(0, 18_000);
    markComparison(issue.key, headToken);
    useSelectionToolbarStore.setState({ selectedText: text });
    void startAction(AIAction.COMPARE_JIRA_WITH_PR);
  }, [ciSummary?.headSha, lastReviewContext, markComparison, pageSnapshot, startAction]);

  const handleCompareApiWithJira = useCallback(() => {
    const text = buildCompareApiWithJiraText();
    if (!text) {
      return;
    }
    const api = useOpenApiSessionStore.getState();
    if (api.contract) {
      api.markAnalyzed(api.contract.documentHash);
    }
    useSelectionToolbarStore.setState({ selectedText: text });
    void startAction(AIAction.COMPARE_API_WITH_JIRA);
  }, [startAction]);

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
      const owner = lastReviewContext?.github?.owner?.trim();
      const repository = lastReviewContext?.github?.repository?.trim();
      const pullRequestNumber = lastReviewContext?.github?.pullRequestNumber;
      const path = finding.filePath?.trim();
      const focus = path ? `File: ${path}\n` : '';
      const applyTarget =
        owner && repository && pullRequestNumber && pullRequestNumber > 0 && path
          ? {
              owner,
              repository,
              pullRequestNumber,
              path,
              findingId: finding.id,
              findingTitle: finding.title,
            }
          : null;
      void startAction(AIAction.SUGGEST_FIX, {
        customPrompt: `Prior PR finding to fix:\n${focus}${finding.raw}`,
        applyTarget,
      });
    },
    [assistant, lastReviewContext, startAction],
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
    const isPrOrFix =
      (assistant.status === 'success' || assistant.status === 'streaming') &&
      (assistant.action === AIAction.REVIEW_ENTIRE_PR || assistant.action === AIAction.SUGGEST_FIX);

    if (!isPrOrFix) {
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
              <div key="menu" className="space-y-1">
                <ActionMenu
                  actions={rankedActions}
                  onSelect={handleSelectAction}
                  pageType={pageSnapshot?.type ?? null}
                  hasOpenApi={Boolean(openApiContext)}
                  hasJiraIssue={Boolean(effectiveJiraKey || githubJiraKeys.length === 1)}
                  hasGithub={Boolean(pageSnapshot?.type === 'github' || prCiDestination)}
                  githubSlot={
                    prCiDestination || pageSnapshot?.type === 'github' ? (
                      <div className="space-y-1 px-1 py-1">
                        {prCiDestination ? (
                          <div className="px-1 py-1">
                            <CiEntryButton onOpen={handleOpenCi} summaryLabel="CI · Status" />
                          </div>
                        ) : null}
                        {prCiDestination ? (
                          <PrOpenApiChangesButton
                            embedded
                            owner={prCiDestination.owner}
                            repository={prCiDestination.repository}
                            pullRequestNumber={prCiDestination.pullRequestNumber}
                            changedFilePaths={(prCiDestination.changedFiles ?? []).map(
                              (f) => f.path,
                            )}
                          />
                        ) : null}
                      </div>
                    ) : null
                  }
                  jiraSlot={
                    effectiveJiraKey ? (
                      <JiraIssuePanel
                        embedded
                        issueKey={effectiveJiraKey}
                        siteHost={effectiveJiraHost}
                        comparisonStale={comparisonStale(comparisonHeadToken)}
                        onCompareWithPr={
                          lastReviewContext?.github?.pullRequestNumber ||
                          pageSnapshot?.github?.pullRequestNumber
                            ? handleCompareJiraWithPr
                            : undefined
                        }
                        relatedPrLabel={
                          lastReviewContext?.github?.pullRequestNumber
                            ? `GitHub PR #${lastReviewContext.github.pullRequestNumber} in session`
                            : pageSnapshot?.github?.pullRequestNumber
                              ? `GitHub PR #${pageSnapshot.github.pullRequestNumber}`
                              : null
                        }
                      />
                    ) : githubJiraKeys.length === 1 ? (
                      <JiraIssuePanel
                        embedded
                        issueKey={githubJiraKeys[0]!}
                        comparisonStale={comparisonStale(comparisonHeadToken)}
                        onCompareWithPr={
                          pageSnapshot?.github?.pullRequestNumber
                            ? handleCompareJiraWithPr
                            : undefined
                        }
                        relatedPrLabel={
                          pageSnapshot?.github?.pullRequestNumber
                            ? `GitHub PR #${pageSnapshot.github.pullRequestNumber} (key in title/body/branch)`
                            : null
                        }
                      />
                    ) : githubJiraKeys.length > 1 ? (
                      <p className="px-3 py-3 text-[11px] text-secondary">
                        Multiple Jira keys detected ({githubJiraKeys.join(', ')}). Open a single
                        issue to continue.
                      </p>
                    ) : null
                  }
                  apiSlot={
                    openApiContext ? (
                      <OpenApiPanel
                        pageOpenApi={openApiContext}
                        onCompareWithJira={handleCompareApiWithJira}
                      />
                    ) : null
                  }
                />
                {ciView !== 'closed' ? <CiPanel /> : null}
              </div>
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
                  assistant.action === AIAction.REVIEW_ENTIRE_PR ||
                  assistant.action === AIAction.SUGGEST_FIX
                    ? githubConnected
                    : null
                }
                applyTarget={
                  assistant.action === AIAction.SUGGEST_FIX ? suggestFixApplyTarget : null
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

            {phase === 'assistant' &&
            (assistant.status === 'streaming' || assistant.status === 'success') &&
            ciView !== 'closed' ? (
              <CiPanel key="ci-panel" />
            ) : null}

            {phase === 'assistant' &&
            (assistant.status === 'streaming' || assistant.status === 'success') &&
            assistant.action === AIAction.REVIEW_ENTIRE_PR &&
            prCiDestination &&
            ciView === 'closed' ? (
              <div key="ci-entry" className="mt-1">
                <CiEntryButton onOpen={handleOpenCi} summaryLabel="CI · Status" />
              </div>
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
