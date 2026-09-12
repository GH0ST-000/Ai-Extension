import { useCallback, useEffect, useMemo } from 'react';
import { knownInSelectedScope, noOrgWideClaim } from '@project-x/shared';

import { cn } from '~/lib/utils/cn';

import type { EngineeringSessionsInput } from '../engineering/engineering.store';
import { githubChangeFromSessions, useMultiRepoStore } from './multi-repo.store';

export type MultiRepoPanelProps = {
  sessions?: EngineeringSessionsInput;
  className?: string;
  compact?: boolean;
};

function likelihoodLabel(value: string): string {
  return value.replaceAll('_', ' ');
}

/**
 * Compact multi-repo intelligence panel — read-only impact / flow.
 * No graph; no Apply Fix across repos.
 */
export function MultiRepoPanel(props: MultiRepoPanelProps) {
  const systems = useMultiRepoStore((s) => s.systems);
  const selectedSystemId = useMultiRepoStore((s) => s.selectedSystemId);
  const enabledRepoKeys = useMultiRepoStore((s) => s.enabledRepoKeys);
  const lastImpact = useMultiRepoStore((s) => s.lastImpact);
  const lastFlow = useMultiRepoStore((s) => s.lastFlow);
  const scopeNote = useMultiRepoStore((s) => s.scopeNote);
  const loading = useMultiRepoStore((s) => s.loading);
  const error = useMultiRepoStore((s) => s.error);
  const panelOpen = useMultiRepoStore((s) => s.panelOpen);
  const loadSystems = useMultiRepoStore((s) => s.loadSystems);
  const selectSystem = useMultiRepoStore((s) => s.selectSystem);
  const toggleEnabledRepoKey = useMultiRepoStore((s) => s.toggleEnabledRepoKey);
  const analyzeImpact = useMultiRepoStore((s) => s.analyzeImpact);
  const traceFlow = useMultiRepoStore((s) => s.traceFlow);
  const setPanelOpen = useMultiRepoStore((s) => s.setPanelOpen);

  useEffect(() => {
    void loadSystems();
  }, [loadSystems]);

  const selected = useMemo(
    () => systems.find((s) => s.id === selectedSystemId) ?? null,
    [systems, selectedSystemId],
  );

  const change = useMemo(() => githubChangeFromSessions(props.sessions ?? {}), [props.sessions]);

  const unavailableCount = lastImpact?.scope.repositoriesUnavailable?.length ?? 0;
  const partial =
    unavailableCount > 0 ||
    Boolean(lastImpact?.scope.truncated) ||
    Boolean(lastFlow?.scope.truncated) ||
    (lastFlow?.gaps.length ?? 0) > 0;

  const handleAnalyze = useCallback(() => {
    if (!change) {
      return;
    }
    void analyzeImpact(change);
  }, [analyzeImpact, change]);

  const handleTrace = useCallback(() => {
    const trigger = change
      ? {
          kind: 'pull_request' as const,
          key: change.pullRequestNumber
            ? `pr:${change.pullRequestNumber}`
            : `${change.owner}/${change.repository}`,
          repository: {
            provider: 'github' as const,
            owner: change.owner,
            repository: change.repository,
          },
          summary: change.summary,
        }
      : {
          kind: 'unknown' as const,
          key: 'selection',
          summary: 'Trace from current selection',
        };
    void traceFlow(trigger);
  }, [change, traceFlow]);

  if (!panelOpen && props.compact !== false && systems.length === 0 && !loading) {
    return null;
  }

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
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">
              Multi-Repo
            </p>
            <p className="mt-0.5 text-[11px] leading-4 text-secondary">
              Read-only · {knownInSelectedScope('impact')}
            </p>
          </div>
          {panelOpen ? (
            <button
              type="button"
              aria-label="Hide multi-repo panel"
              onClick={() => setPanelOpen(false)}
              className="rounded-md px-1.5 py-0.5 text-[10px] font-semibold text-muted hover:bg-icon hover:text-primary"
            >
              Hide
            </button>
          ) : null}
        </div>

        {error ? (
          <p className="mt-1.5 text-[11px] text-[#e11d48]" role="alert">
            {error}
          </p>
        ) : null}

        {partial || scopeNote ? (
          <p
            className="mt-1.5 rounded-md border border-border bg-icon px-2 py-1 text-[10px] leading-3.5 text-secondary"
            role="status"
          >
            {scopeNote ?? noOrgWideClaim()}
            {partial ? ' Partial scope — some repositories or hops unavailable.' : ''}
          </p>
        ) : null}

        <label className="mt-2 block text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
          System
          <select
            className="mt-1 w-full rounded-lg border border-border bg-surface px-2 py-1.5 text-[12px] font-medium text-primary outline-none"
            value={selectedSystemId ?? ''}
            onChange={(event) => selectSystem(event.target.value || null)}
            disabled={loading || systems.length === 0}
            aria-label="Select multi-repo system"
          >
            {systems.length === 0 ? <option value="">No systems configured</option> : null}
            {systems.map((system) => (
              <option key={system.id} value={system.id}>
                {system.name}
              </option>
            ))}
          </select>
        </label>

        {selected ? (
          <fieldset className="mt-2 space-y-1">
            <legend className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
              Enabled repositories
            </legend>
            {selected.repositories.map((ref) => {
              const key = `${ref.repository.owner}/${ref.repository.repository}`;
              return (
                <label
                  key={key}
                  className="flex cursor-pointer items-center gap-2 text-[11px] text-secondary"
                >
                  <input
                    type="checkbox"
                    checked={enabledRepoKeys.includes(key)}
                    onChange={() => toggleEnabledRepoKey(key)}
                    disabled={loading}
                  />
                  <span className="font-mono">{key}</span>
                  <span className="text-muted">({ref.role})</span>
                </label>
              );
            })}
          </fieldset>
        ) : null}

        <div className="mt-2 grid grid-cols-2 gap-1.5">
          <button
            type="button"
            disabled={loading || !selectedSystemId || !change}
            onClick={handleAnalyze}
            className={cn(
              'rounded-lg px-2 py-1.5 text-left text-[11px] font-semibold',
              'bg-icon text-primary hover:bg-hover transition-colors',
              'disabled:opacity-50',
            )}
          >
            Analyze Change Impact
          </button>
          <button
            type="button"
            disabled={loading || !selectedSystemId}
            onClick={handleTrace}
            className={cn(
              'rounded-lg px-2 py-1.5 text-left text-[11px] font-semibold',
              'bg-icon text-primary hover:bg-hover transition-colors',
              'disabled:opacity-50',
            )}
          >
            Trace Flow
          </button>
        </div>

        {loading ? (
          <p className="mt-2 text-[11px] text-muted" role="status">
            Analyzing selected repositories…
          </p>
        ) : null}

        {lastImpact ? (
          <div className="mt-2 space-y-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
              Impact
            </p>
            {lastImpact.impactedRepositories.length === 0 ? (
              <p className="text-[11px] text-secondary">
                Impact is not evident in the analyzed scope.
              </p>
            ) : (
              <ul className="space-y-1">
                {lastImpact.impactedRepositories.slice(0, 6).map((item) => (
                  <li
                    key={`${item.repository.owner}/${item.repository.repository}:${item.impactType}`}
                    className="rounded-md border border-border px-2 py-1.5"
                  >
                    <p className="font-mono text-[11px] font-semibold text-primary">
                      {item.repository.owner}/{item.repository.repository}
                    </p>
                    <p className="text-[10px] text-secondary">
                      Likelihood: {likelihoodLabel(item.likelihood)} ·{' '}
                      {likelihoodLabel(item.impactType)} · change{' '}
                      {likelihoodLabel(item.requiresChange)}
                    </p>
                    <p className="mt-0.5 text-[10px] leading-3.5 text-muted">{item.summary}</p>
                  </li>
                ))}
              </ul>
            )}
            {lastImpact.risks.length > 0 ? (
              <ul className="space-y-1" aria-label="Risks">
                {lastImpact.risks.slice(0, 3).map((risk) => (
                  <li
                    key={risk.code}
                    className="rounded-md border border-border bg-icon px-2 py-1 text-[10px] text-secondary"
                  >
                    <span className="font-semibold text-primary">Severity: {risk.severity}</span> —{' '}
                    {risk.summary}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {lastFlow ? (
          <div className="mt-2 space-y-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">Flow</p>
            <p className="text-[11px] leading-4 text-secondary">{lastFlow.summary}</p>
            <ol className="space-y-1">
              {lastFlow.nodes.slice(0, 8).map((node, index) => (
                <li
                  key={node.id}
                  className="flex gap-2 rounded-md border border-border px-2 py-1 text-[11px]"
                >
                  <span className="shrink-0 font-semibold text-muted">{index + 1}</span>
                  <span>
                    <span className="font-medium text-primary">{node.label}</span>
                    <span className="block text-[10px] text-muted">
                      {node.type.replaceAll('_', ' ')}
                      {node.repository
                        ? ` · ${node.repository.owner}/${node.repository.repository}`
                        : ''}
                      {node.confidence ? ` · confidence ${node.confidence}` : ''}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
            {lastFlow.gaps.length > 0 ? (
              <p className="text-[10px] text-secondary" role="status">
                Gaps: {lastFlow.gaps.map((g) => g.summary).join('; ')}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
