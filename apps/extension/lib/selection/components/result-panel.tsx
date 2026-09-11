import { forwardRef, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { AIAction, type PageContext, type PRReviewFinding } from '@project-x/types';

import { cn } from '~/lib/utils/cn';

import { getActionLabel } from '../constants';
import {
  buildPrReviewReport,
  type PrFindingDisposition,
  type PrFindingDispositionMap,
  type PrFindingFilter,
} from '../utils/build-pr-review-report';
import { parseSuggestFixContent } from '../utils/parse-suggest-fix';
import { PrReviewReportView } from './pr-review-report-view';
import { ApplyFixPanel, canOfferApplyFix } from '../patch-apply/apply-fix-panel';
import type { SuggestFixApplyTarget } from '../patch-apply/patch-apply.store';
import { usePatchApplyStore } from '../patch-apply/patch-apply.store';
import {
  EngineeringAlignmentView,
  useEngineeringAlignmentView,
} from '../engineering/engineering-alignment-view';
import { useEngineeringSessionStore } from '../engineering/engineering.store';

type ResultPanelProps = {
  action: AIAction;
  content: string;
  streaming?: boolean;
  canReplace?: boolean;
  reviewContext?: PageContext | null;
  findingFilter?: PrFindingFilter;
  findingDispositions?: PrFindingDispositionMap;
  /** Optional freshness warning (e.g. engineering alignment sources changed). */
  staleMessage?: string | null;
  onCopy: () => Promise<boolean>;
  onCopyFix?: () => Promise<boolean>;
  onCopyFullReview?: () => Promise<boolean>;
  onCopySummary?: () => Promise<boolean>;
  onCopyCommentDraft?: () => Promise<boolean>;
  onPostComment?: (body: string) => Promise<{ ok: boolean; message?: string; commentUrl?: string }>;
  githubConnected?: boolean | null;
  applyTarget?: SuggestFixApplyTarget | null;
  onSuggestFix?: () => void;
  onSuggestFixForFinding?: (finding: PRReviewFinding) => void;
  onFindingFilterChange?: (filter: PrFindingFilter) => void;
  onSetFindingDisposition?: (findingId: string, disposition: PrFindingDisposition | null) => void;
  onReplace?: () => { ok: boolean; message?: string };
  onRetry: () => void;
  onBack: () => void;
  onClose: () => void;
};

/** Widen Suggest Fix so code stays readable; clamp to the viewport. */
function suggestFixPanelWidthPx(fixCode: string | null | undefined): number {
  const viewportCap =
    typeof window === 'undefined' ? 520 : Math.max(320, Math.min(560, window.innerWidth - 32));
  const minWidth = 380;
  if (!fixCode) {
    return Math.min(viewportCap, 420);
  }

  const longestLine = fixCode.split('\n').reduce((max, line) => Math.max(max, line.length), 0);
  // ~7.1px per mono char at 11px + line gutter + panel chrome
  const contentWidth = Math.ceil(longestLine * 7.1 + 56);
  return Math.min(viewportCap, Math.max(minWidth, contentWidth));
}

function SuggestFixView({
  content,
  streaming,
  parsed,
}: {
  content: string;
  streaming: boolean;
  parsed: ReturnType<typeof parseSuggestFixContent>;
}) {
  const hasMeta = Boolean(parsed.issue || parsed.why || parsed.note || parsed.prose);
  const code = parsed.fixCode;
  const lines = code ? code.split('\n') : [];

  return (
    <div className="space-y-3">
      {hasMeta ? (
        <div className="space-y-2 rounded-lg border border-border bg-surface/80 px-2.5 py-2.5">
          {parsed.issue ? (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
                Issue
              </p>
              <p className="mt-0.5 text-[12px] leading-4 text-primary">{parsed.issue}</p>
            </div>
          ) : null}
          {parsed.why ? (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
                Why
              </p>
              <p className="mt-0.5 text-[12px] leading-4 text-secondary">{parsed.why}</p>
            </div>
          ) : null}
          {parsed.note ? <p className="text-[11px] leading-4 text-muted">{parsed.note}</p> : null}
          {parsed.prose ? (
            <p className="whitespace-pre-wrap break-words text-[12px] leading-4 text-secondary">
              {parsed.prose}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="overflow-hidden rounded-lg border border-border bg-[#0d0d10] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
        <div className="flex items-center justify-between gap-2 border-b border-white/10 bg-[#141418] px-2.5 py-1.5">
          <div className="flex min-w-0 items-center gap-2">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
            <p className="truncate text-[10px] font-semibold uppercase tracking-[0.14em] text-[#a8a8b3]">
              Proposed fix
            </p>
          </div>
          {parsed.language ? (
            <span className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wide text-[#8b8b98] bg-white/5">
              {parsed.language}
            </span>
          ) : null}
        </div>

        {code ? (
          <div className="py-1">
            <table className="w-full table-fixed border-collapse font-mono text-[11px] leading-[1.55]">
              <tbody>
                {lines.map((line, index) => (
                  <tr key={`L${index + 1}`} className="hover:bg-white/[0.03]">
                    <td className="w-8 select-none whitespace-nowrap border-r border-white/5 px-1.5 py-0.5 text-right text-[10px] text-[#5c5c68] align-top">
                      {index + 1}
                    </td>
                    <td className="min-w-0 break-words whitespace-pre-wrap px-2.5 py-0.5 text-[#e8e8ec]">
                      {line || ' '}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <pre className="px-3 py-2.5 font-mono text-[11px] leading-4 text-[#e8e8ec] whitespace-pre-wrap break-words">
            {content}
            {streaming ? <span className="ml-0.5 inline-block text-accent">0</span> : null}
          </pre>
        )}
      </div>

      {streaming && code ? <span className="inline-block text-[11px] text-accent">0</span> : null}
    </div>
  );
}

export const ResultPanel = forwardRef<HTMLDivElement, ResultPanelProps>(function ResultPanel(
  {
    action,
    content,
    streaming = false,
    canReplace = false,
    reviewContext = null,
    findingFilter = 'all',
    findingDispositions = {},
    staleMessage = null,
    onCopy,
    onCopyFix,
    onCopyFullReview,
    onCopySummary,
    onCopyCommentDraft,
    onPostComment,
    githubConnected = null,
    applyTarget = null,
    onSuggestFix,
    onSuggestFixForFinding,
    onFindingFilterChange,
    onSetFindingDisposition,
    onReplace,
    onRetry,
    onBack,
    onClose,
  },
  ref,
) {
  const [copied, setCopied] = useState(false);
  const [copiedFix, setCopiedFix] = useState(false);
  const [copiedReview, setCopiedReview] = useState(false);
  const [replaced, setReplaced] = useState(false);
  const [replaceError, setReplaceError] = useState<string | null>(null);
  const [showApplyFix, setShowApplyFix] = useState(false);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const patchPhase = usePatchApplyStore((s) => s.phase);

  const isSuggestFix = action === AIAction.SUGGEST_FIX;
  const isEntirePr = action === AIAction.REVIEW_ENTIRE_PR;
  const isEngineeringAlignment = action === AIAction.ANALYZE_ENGINEERING_ALIGNMENT;
  const engineeringContext = useEngineeringSessionStore((s) => s.context);
  const engineeringBinding = useEngineeringSessionStore((s) => s.binding);
  const engineeringView = useEngineeringAlignmentView(
    content,
    isEngineeringAlignment ? engineeringContext : null,
    isEngineeringAlignment ? engineeringBinding : null,
  );
  const parsedFix = useMemo(
    () => (isSuggestFix ? parseSuggestFixContent(content) : null),
    [content, isSuggestFix],
  );
  const prReport = useMemo(
    () => (isEntirePr ? buildPrReviewReport({ markdown: content, context: reviewContext }) : null),
    [content, isEntirePr, reviewContext],
  );
  const dispositions = useMemo(() => findingDispositions, [findingDispositions]);
  const showSuggestFix = Boolean(
    isSuggestFix && parsedFix && (parsedFix.fixCode || parsedFix.issue || parsedFix.why),
  );
  const showPrReport = Boolean(isEntirePr && prReport);
  const isApiOrJiraResult =
    action === AIAction.EXPLAIN_API_ENDPOINT ||
    action === AIAction.EXPLAIN_API_REQUEST ||
    action === AIAction.EXPLAIN_API_RESPONSE ||
    action === AIAction.GENERATE_API_EXAMPLE ||
    action === AIAction.ANALYZE_API_CONTRACT ||
    action === AIAction.COMPARE_API_WITH_JIRA ||
    action === AIAction.ANALYZE_API_CHANGES ||
    action === AIAction.SUMMARIZE_JIRA_ISSUE ||
    action === AIAction.EXTRACT_ACCEPTANCE_CRITERIA ||
    action === AIAction.CREATE_TECHNICAL_PLAN ||
    action === AIAction.ANALYZE_JIRA_RISKS ||
    action === AIAction.COMPARE_JIRA_WITH_PR ||
    action === AIAction.ANALYZE_ENGINEERING_ALIGNMENT;

  const panelWidthPx = useMemo(() => {
    if (isSuggestFix) {
      return suggestFixPanelWidthPx(parsedFix?.fixCode);
    }
    if (isEntirePr) {
      return 400;
    }
    if (isApiOrJiraResult) {
      return 340;
    }
    return 300;
  }, [isSuggestFix, isEntirePr, isApiOrJiraResult, parsedFix?.fixCode]);

  useEffect(() => {
    if (!streaming || !stickToBottomRef.current) {
      return;
    }
    const node = scrollerRef.current;
    if (!node) {
      return;
    }
    node.scrollTop = node.scrollHeight;
  }, [content, streaming]);

  useEffect(() => {
    setReplaced(false);
    setReplaceError(null);
    setCopiedFix(false);
    setCopiedReview(false);
    setShowApplyFix(false);
  }, [content, action]);

  return (
    <motion.div
      ref={ref}
      role="region"
      aria-label={`${getActionLabel(action)} result`}
      initial={{ opacity: 0, scale: 0.98, y: 4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98, y: 2 }}
      transition={{ type: 'spring', stiffness: 480, damping: 32, mass: 0.55 }}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      style={{ width: panelWidthPx }}
      className={cn(
        'pointer-events-auto flex max-h-[440px] flex-col overflow-hidden rounded-[14px]',
        'bg-elevated text-primary shadow-menu backdrop-blur-2xl border border-border',
      )}
    >
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
          {getActionLabel(action)}
          {streaming ? ' · Streaming' : ''}
        </p>
        <button
          type="button"
          onClick={onClose}
          className="rounded-md px-2 py-1 text-[11px] text-muted hover:bg-hover hover:text-primary"
        >
          Close
        </button>
      </div>

      <div
        ref={scrollerRef}
        onScroll={(event) => {
          const target = event.currentTarget;
          const distanceFromBottom = target.scrollHeight - target.scrollTop - target.clientHeight;
          stickToBottomRef.current = distanceFromBottom < 48;
        }}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5"
      >
        {staleMessage ? (
          <p className="mb-2 text-[11px] leading-4 text-secondary" role="status">
            {staleMessage}
          </p>
        ) : null}
        {showPrReport && prReport ? (
          <PrReviewReportView
            report={prReport}
            streaming={streaming}
            filter={findingFilter}
            dispositions={dispositions}
            onFilterChange={(next) => onFindingFilterChange?.(next)}
            onSetDisposition={(id, disposition) => onSetFindingDisposition?.(id, disposition)}
            onSuggestFixForFinding={onSuggestFixForFinding}
            onCopySummary={onCopySummary}
            onCopyCommentDraft={onCopyCommentDraft}
            onPostComment={onPostComment}
            githubConnected={githubConnected}
          />
        ) : showSuggestFix && parsedFix ? (
          <div className="space-y-3">
            <SuggestFixView content={content} streaming={streaming} parsed={parsedFix} />
            {!streaming &&
            showApplyFix &&
            applyTarget &&
            canOfferApplyFix({ fixCode: parsedFix.fixCode, target: applyTarget }) ? (
              <ApplyFixPanel
                fixCode={parsedFix.fixCode!}
                target={applyTarget}
                githubConnected={githubConnected}
                onClose={() => {
                  setShowApplyFix(false);
                  if (patchPhase === 'success' || patchPhase === 'idle') {
                    usePatchApplyStore.getState().reset();
                  }
                }}
              />
            ) : null}
          </div>
        ) : engineeringView ? (
          <EngineeringAlignmentView analysis={engineeringView} streaming={streaming} />
        ) : (
          <div className="rounded-lg border border-border bg-surface/70 px-2.5 py-2.5">
            <p className="whitespace-pre-wrap break-words text-[12.5px] leading-[1.55] text-primary">
              {content}
              {streaming ? <span className="ml-0.5 inline-block text-accent">0</span> : null}
            </p>
          </div>
        )}
        {replaceError ? (
          <p className="mt-2 text-[11px] leading-4 text-[#e11d48]">{replaceError}</p>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-1 border-t border-border px-2.5 pb-3.5 pt-2.5">
        {action === AIAction.REVIEW_CODE && onSuggestFix && !streaming ? (
          <button
            type="button"
            disabled={content.trim().length === 0}
            onClick={onSuggestFix}
            className="rounded-md px-2 py-1 text-[11px] font-semibold text-accent hover:bg-accent-soft disabled:opacity-40"
          >
            Suggest Fix
          </button>
        ) : null}
        {isEntirePr && onCopyFullReview && !streaming ? (
          <button
            type="button"
            disabled={content.trim().length === 0}
            onClick={async () => {
              const ok = await onCopyFullReview();
              if (!ok) {
                return;
              }
              setCopiedReview(true);
              window.setTimeout(() => setCopiedReview(false), 1200);
            }}
            className="rounded-md px-2 py-1 text-[11px] font-semibold text-accent hover:bg-accent-soft disabled:opacity-40"
          >
            {copiedReview ? 'Copied Markdown' : 'Export Markdown'}
          </button>
        ) : null}
        {isSuggestFix && onCopyFix ? (
          <button
            type="button"
            disabled={streaming || content.trim().length === 0}
            onClick={async () => {
              const ok = await onCopyFix();
              if (!ok) {
                return;
              }
              setCopiedFix(true);
              window.setTimeout(() => setCopiedFix(false), 1200);
            }}
            className="rounded-md px-2 py-1 text-[11px] font-semibold text-accent hover:bg-accent-soft disabled:opacity-40"
          >
            {copiedFix ? 'Copied Fix' : 'Copy Fix'}
          </button>
        ) : null}
        {isSuggestFix &&
        !streaming &&
        canOfferApplyFix({ fixCode: parsedFix?.fixCode, target: applyTarget }) ? (
          <button
            type="button"
            onClick={() => {
              setShowApplyFix(true);
              usePatchApplyStore.getState().setPhase('idle');
            }}
            className="rounded-md px-2 py-1 text-[11px] font-semibold text-accent hover:bg-accent-soft"
          >
            Apply Fix
          </button>
        ) : null}
        {canReplace && onReplace ? (
          <button
            type="button"
            disabled={streaming || content.trim().length === 0 || replaced}
            onClick={() => {
              const result = onReplace();
              if (result.ok) {
                setReplaced(true);
                setReplaceError(null);
                return;
              }
              setReplaceError(result.message ?? 'Unable to replace selection.');
            }}
            className="rounded-md px-2 py-1 text-[11px] font-semibold text-accent hover:bg-accent-soft disabled:opacity-40"
          >
            {replaced ? 'Replaced' : 'Replace'}
          </button>
        ) : null}
        <button
          type="button"
          disabled={streaming || content.trim().length === 0}
          onClick={async () => {
            const ok = await onCopy();
            if (!ok) {
              return;
            }
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          }}
          className="rounded-md px-2 py-1 text-[11px] font-medium text-secondary hover:bg-hover hover:text-primary disabled:opacity-40"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md px-2 py-1 text-[11px] font-medium text-secondary hover:bg-hover hover:text-primary"
        >
          Retry
        </button>
        <button
          type="button"
          onClick={onBack}
          className="rounded-md px-2 py-1 text-[11px] font-medium text-secondary hover:bg-hover hover:text-primary"
        >
          Back
        </button>
      </div>
    </motion.div>
  );
});
