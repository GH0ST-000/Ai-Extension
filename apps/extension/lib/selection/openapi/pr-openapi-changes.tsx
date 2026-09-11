import { useCallback, useMemo, useState } from 'react';
import { AIAction } from '@project-x/types';
import { filterOpenApiSpecPaths } from '@project-x/shared';

import { cn } from '~/lib/utils/cn';

import { fetchPullRequestFileVersions, GithubApiError } from '../../services/github-api';
import { diffOpenApiContracts, OpenApiApiError } from '../../services/openapi-api';
import { ACTION_ICONS } from '../components/action-icons';
import { useSelectionToolbarStore } from '../store';
import { formatApiChangesPromptText } from './openapi.store';

/**
 * Compact Day 18 entry: when a GitHub PR Files context includes OpenAPI/Swagger
 * paths, fetch base+head via trusted GitHub Contents APIs, run /openapi/diff,
 * then start ANALYZE_API_CHANGES. Does not mutate GitHub.
 */
export function PrOpenApiChangesButton(props: {
  owner: string;
  repository: string;
  pullRequestNumber: number;
  changedFilePaths: string[];
  embedded?: boolean;
}) {
  const startAction = useSelectionToolbarStore((s) => s.startAction);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const openApiPaths = useMemo(
    () => filterOpenApiSpecPaths(props.changedFilePaths),
    [props.changedFilePaths],
  );

  const activePath =
    selectedPath && openApiPaths.includes(selectedPath) ? selectedPath : (openApiPaths[0] ?? null);

  const AnalyzeIcon = ACTION_ICONS[AIAction.ANALYZE_API_CHANGES];

  const runAnalyze = useCallback(async () => {
    if (!activePath) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const versions = await fetchPullRequestFileVersions(
        props.owner,
        props.repository,
        props.pullRequestNumber,
        activePath,
      );

      if (
        !versions.basePresent ||
        !versions.headPresent ||
        !versions.baseContent ||
        !versions.headContent
      ) {
        setError(
          !versions.basePresent && versions.headPresent
            ? 'OpenAPI file is new on this PR (no base version). Structural compare needs both SHAs.'
            : versions.basePresent && !versions.headPresent
              ? 'OpenAPI file was removed on this PR (no head version). Structural compare needs both SHAs.'
              : 'Could not load OpenAPI file at both base and head SHAs.',
        );
        return;
      }

      const diff = await diffOpenApiContracts({
        baseContent: versions.baseContent,
        headContent: versions.headContent,
        baseRef: versions.baseSha,
        headRef: versions.headSha,
      });

      const text = formatApiChangesPromptText(diff, {
        path: versions.path,
        owner: versions.owner,
        repository: versions.repository,
        pullRequestNumber: versions.pullRequestNumber,
      });

      useSelectionToolbarStore.setState({ selectedText: text });
      void startAction(AIAction.ANALYZE_API_CHANGES);
    } catch (err) {
      const message =
        err instanceof OpenApiApiError || err instanceof GithubApiError
          ? err.message
          : 'Unable to analyze API contract changes.';
      setError(message);
    } finally {
      setBusy(false);
    }
  }, [activePath, props.owner, props.pullRequestNumber, props.repository, startAction]);

  if (openApiPaths.length === 0) {
    return null;
  }

  const inner = (
    <div className={props.embedded ? 'px-1 py-1' : 'p-1'}>
      {!props.embedded ? (
        <div className="border-b border-border px-2 pb-2 pt-1.5">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
            API · PR contract
          </p>
        </div>
      ) : (
        <p className="px-2 pt-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
          Contract change
        </p>
      )}

      <div className="max-h-[88px] space-y-0.5 overflow-y-auto px-1 pt-1">
        {openApiPaths.map((path) => {
          const active = path === activePath;
          return (
            <button
              key={path}
              type="button"
              disabled={busy}
              onClick={() => setSelectedPath(path)}
              className={cn(
                'w-full truncate rounded-md px-2 py-1.5 text-left font-mono text-[11px] transition-colors',
                active
                  ? 'bg-elevated text-primary shadow-sm ring-1 ring-border'
                  : 'text-secondary hover:bg-hover',
              )}
              title={path}
            >
              {path}
            </button>
          );
        })}
      </div>

      <button
        type="button"
        disabled={busy || !activePath}
        onClick={() => {
          void runAnalyze();
        }}
        className={cn(
          'group mt-0.5 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left',
          'text-primary transition-colors duration-100',
          'hover:bg-hover focus-visible:bg-active',
          'outline-none focus-visible:ring-1 focus-visible:ring-accent/40',
          'disabled:pointer-events-none disabled:opacity-40',
        )}
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-icon text-secondary transition-colors group-hover:text-accent">
          <AnalyzeIcon className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[12.5px] font-medium leading-4 tracking-tight">
            {busy ? 'Analyzing…' : 'Analyze API Changes'}
          </span>
          <span className="mt-px block truncate text-[11px] leading-tight text-muted">
            Structural base → head diff
          </span>
        </span>
      </button>
      {error ? (
        <p className="px-2 pb-1.5 text-[11px] text-[#e11d48]" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );

  if (props.embedded) {
    return inner;
  }

  return (
    <div
      className={cn(
        'w-[280px] overflow-hidden rounded-[12px] border border-border',
        'bg-elevated text-primary shadow-menu backdrop-blur-2xl',
      )}
    >
      {inner}
    </div>
  );
}
