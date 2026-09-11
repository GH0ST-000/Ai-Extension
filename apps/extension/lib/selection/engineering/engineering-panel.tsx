import { useCallback, useMemo } from 'react';
import { buildEngineeringContext } from '@project-x/shared';
import { AIAction } from '@project-x/types';

import { cn } from '~/lib/utils/cn';

import { useSelectionToolbarStore } from '../store';
import {
  assembleEngineeringBuildInput,
  bindingFromEngineeringContext,
  canAnalyzeEngineeringAlignment,
  detectEngineeringSourceFlags,
  formatEngineeringBannerSummary,
  prepareEngineeringAlignmentPrompt,
  useEngineeringSessionStore,
  type EngineeringSessionsInput,
} from './engineering.store';

export type EngineeringContextBannerProps = {
  sessions: EngineeringSessionsInput;
  className?: string;
};

/**
 * Slim cross-context banner shown above ActionMenu when ≥2 sources are available.
 * Banner-only entry for ANALYZE_ENGINEERING_ALIGNMENT (not listed in tab catalogs).
 */
export function EngineeringContextBanner(props: EngineeringContextBannerProps) {
  const startAction = useSelectionToolbarStore((s) => s.startAction);
  const buildFromSessions = useEngineeringSessionStore((s) => s.buildFromSessions);
  const markAnalyzed = useEngineeringSessionStore((s) => s.markAnalyzed);
  const lastError = useEngineeringSessionStore((s) => s.lastError);

  const flags = useMemo(() => detectEngineeringSourceFlags(props.sessions), [props.sessions]);
  const canAnalyze = canAnalyzeEngineeringAlignment(flags);

  const preview = useMemo(() => {
    if (!canAnalyze) {
      return null;
    }
    const result = buildEngineeringContext(assembleEngineeringBuildInput(props.sessions));
    if ('error' in result) {
      return null;
    }
    return result;
  }, [canAnalyze, props.sessions]);

  const handleAnalyze = useCallback(() => {
    const result = buildFromSessions(props.sessions);
    if ('error' in result) {
      return;
    }
    const { text, binding } = prepareEngineeringAlignmentPrompt(result);
    markAnalyzed(binding, text);
    useSelectionToolbarStore.setState({ selectedText: text });
    void startAction(AIAction.ANALYZE_ENGINEERING_ALIGNMENT);
  }, [buildFromSessions, markAnalyzed, props.sessions, startAction]);

  if (!canAnalyze || !preview) {
    return null;
  }

  const summary = formatEngineeringBannerSummary(preview);

  return (
    <div
      className={cn(
        'pointer-events-auto w-[300px] overflow-hidden rounded-[14px]',
        'bg-elevated text-primary shadow-menu backdrop-blur-2xl',
        'border border-border',
        props.className,
      )}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <div className="px-3 py-2.5">
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
          Engineering Context
        </p>
        <p className="mt-1 text-[12px] font-medium leading-4 text-primary">{summary}</p>
        {preview.scope.partial ? (
          <p className="mt-1 text-[10px] leading-3 text-muted">
            Partial context — evidence limited
          </p>
        ) : null}
        {lastError ? (
          <p className="mt-1 text-[11px] text-[#e11d48]" role="alert">
            {lastError}
          </p>
        ) : null}
        <button
          type="button"
          onClick={handleAnalyze}
          className={cn(
            'mt-2 w-full rounded-lg px-2.5 py-1.5 text-left',
            'bg-icon text-[12px] font-semibold text-primary',
            'hover:bg-hover transition-colors',
          )}
        >
          Analyze Alignment
        </button>
      </div>
    </div>
  );
}

/** True when the last engineering analysis binding no longer matches live sessions. */
export function useEngineeringAnalysisStale(sessions: EngineeringSessionsInput): boolean {
  const isStale = useEngineeringSessionStore((s) => s.isStale);
  const binding = useEngineeringSessionStore((s) => s.binding);

  return useMemo(() => {
    if (!binding) {
      return false;
    }
    const result = buildEngineeringContext(assembleEngineeringBuildInput(sessions));
    if ('error' in result) {
      return true;
    }
    return isStale(bindingFromEngineeringContext(result));
  }, [binding, isStale, sessions]);
}
