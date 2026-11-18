'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  MultiRepoRepositoryRole,
  ProjectSystem,
  ProjectSystemRepositoryRef,
  RelatedRepositoryCandidate,
  RepositoryIdentity,
  RepositoryRelationship,
} from '@project-x/types';

import { EmptyState } from '../../../components/empty-state';
import { AnalysisResult, type AnalysisState } from '../../../components/systems/analysis-result';
import {
  AddRepositoryDialog,
  ConfirmRemoveDialog,
  CreateSystemDialog,
  SystemSettingsDialog,
} from '../../../components/systems/system-dialogs';
import {
  CandidateList,
  GithubConnectionNotice,
  RelationshipList,
  RepositoryList,
  SystemOverview,
  SystemSelectorCard,
  type Operation,
} from '../../../components/systems/system-sections';
import {
  analysisUsage,
  candidateKey,
  describeError,
  lastValidatedAt,
  repoLabel,
  sameRepo,
  summarizeDiscovery,
  summarizeRefresh,
  type ErrorGuidance,
} from '../../../components/systems/systems-model';
import {
  BUTTON_PRIMARY,
  BUTTON_SECONDARY,
  Callout,
  Spinner,
} from '../../../components/systems/systems-ui';
import {
  addSystemRepository,
  createSystem,
  deleteSystem,
  discoverRelationships,
  getGithubConnection,
  listRelationships,
  listSystems,
  refreshSystem,
  removeSystemRepository,
  updateSystem,
  updateSystemRepository,
} from '../../../lib/api';
import { notify } from '../../../lib/notify';
import { useWorkspace } from '../../../lib/workspace-context';

type Dialogs = 'create' | 'add' | 'settings' | null;

export default function SystemsPage() {
  const {
    ready: workspaceReady,
    workspaceRevision,
    current: workspaceContext,
    refresh: refreshWorkspace,
  } = useWorkspace();
  const usage = analysisUsage(workspaceContext?.usage);
  /** Plan without Systems (known from the workspace bootstrap; the API still enforces it). */
  const featureMissing = workspaceContext?.entitlements.multiRepoIntelligence === false;
  const analysisBlocked = featureMissing || usage?.remaining === 0;

  const [systems, setSystems] = useState<ProjectSystem[] | null>(null);
  const [loadError, setLoadError] = useState<ErrorGuidance | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [relationships, setRelationships] = useState<RepositoryRelationship[]>([]);
  const [relationshipsLoaded, setRelationshipsLoaded] = useState(false);
  const [relationshipsError, setRelationshipsError] = useState<ErrorGuidance | null>(null);
  /** null until an analysis ran for this system in this visit (never an invented 0). */
  const [candidates, setCandidates] = useState<RelatedRepositoryCandidate[] | null>(null);
  const [unavailable, setUnavailable] = useState<RepositoryIdentity[] | null>(null);
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [analysis, setAnalysis] = useState<AnalysisState>({ status: 'idle' });
  const [operation, setOperation] = useState<Operation>(null);
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [removing, setRemoving] = useState<ProjectSystemRepositoryRef | null>(null);
  const [githubConnected, setGithubConnected] = useState<boolean | null>(null);

  /**
   * Scope guard: bumps whenever the workspace or the selected system changes (and on
   * unmount). Async results from an older scope are dropped, so a slow response can never
   * show one system's (or workspace's) data under another.
   */
  const scopeRef = useRef(0);
  /** Bumps only on workspace change / unmount (system list, GitHub status). */
  const workspaceScopeRef = useRef(0);
  /** Synchronous lock against double clicks before React re-renders. */
  const lockRef = useRef(false);

  const selected = useMemo(
    () => systems?.find((s) => s.id === selectedId) ?? null,
    [systems, selectedId],
  );
  /** Hides dismissed suggestions and ones already added to the system (e.g. manually). */
  const visibleCandidates = useMemo(
    () =>
      candidates?.filter(
        (c) =>
          !dismissed.includes(candidateKey(c)) &&
          !selected?.repositories.some((r) => sameRepo(r.repository, c.repository)),
      ) ?? null,
    [candidates, dismissed, selected],
  );

  const replaceSystem = useCallback((updated: ProjectSystem) => {
    setSystems((prev) => prev?.map((s) => (s.id === updated.id ? updated : s)) ?? prev);
  }, []);

  const loadSystems = useCallback(async (preferId?: string | null) => {
    const scope = workspaceScopeRef.current;
    setLoadError(null);
    try {
      const list = await listSystems();
      if (scope !== workspaceScopeRef.current) return;
      setSystems(list);
      setSelectedId((prev) => {
        const wanted = preferId ?? prev;
        return wanted && list.some((s) => s.id === wanted) ? wanted : (list[0]?.id ?? null);
      });
    } catch (err) {
      if (scope !== workspaceScopeRef.current) return;
      setSystems(null);
      setLoadError(describeError(err, 'Systems could not be loaded'));
    }
  }, []);

  // Workspace change: forget everything from the previous workspace, then reload.
  useEffect(() => {
    if (!workspaceReady) return;
    workspaceScopeRef.current += 1;
    scopeRef.current += 1;
    lockRef.current = false;
    setSystems(null);
    setSelectedId(null);
    setOperation(null);
    setDialog(null);
    setRemoving(null);
    setGithubConnected(null);
    void loadSystems(null);
    const scope = workspaceScopeRef.current;
    getGithubConnection()
      .then((status) => {
        if (scope === workspaceScopeRef.current) setGithubConnected(status.connected);
      })
      .catch(() => undefined); // unknown → no notice rather than a wrong one
  }, [workspaceReady, workspaceRevision, loadSystems]);

  // System change: results of one system never carry over to another.
  useEffect(() => {
    scopeRef.current += 1;
    lockRef.current = false;
    setOperation(null);
    setAnalysis({ status: 'idle' });
    setCandidates(null);
    setUnavailable(null);
    setDismissed([]);
    setRelationships([]);
    setRelationshipsLoaded(false);
    setRelationshipsError(null);
    if (!selectedId) return;
    const scope = scopeRef.current;
    listRelationships(selectedId)
      .then((list) => {
        if (scope !== scopeRef.current) return;
        setRelationships(list);
        setRelationshipsLoaded(true);
      })
      .catch((err: unknown) => {
        if (scope !== scopeRef.current) return;
        setRelationshipsLoaded(true);
        setRelationshipsError(describeError(err, 'Relationships could not be loaded'));
      });
  }, [selectedId]);

  useEffect(
    () => () => {
      scopeRef.current += 1; // unmount: ignore late responses
      workspaceScopeRef.current += 1;
    },
    [],
  );

  /** Runs one mutation/analysis at a time; returns undefined if the scope changed. */
  async function exclusive<T>(
    kind: Exclude<Operation, null>,
    run: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; error: unknown } | undefined> {
    if (lockRef.current) return undefined;
    lockRef.current = true;
    const scope = scopeRef.current;
    setOperation(kind);
    try {
      const value = await run();
      return scope === scopeRef.current ? { ok: true, value } : undefined;
    } catch (error) {
      return scope === scopeRef.current ? { ok: false, error } : undefined;
    } finally {
      if (scope === scopeRef.current) {
        lockRef.current = false;
        setOperation(null);
      }
    }
  }

  // ── analysis ──────────────────────────────────────────────────────────────

  async function onRefresh() {
    if (!selected) return;
    const system = selected;
    setAnalysis({ status: 'running', kind: 'refresh' });
    const result = await exclusive('refresh', () => refreshSystem(system.id));
    refreshWorkspace().catch(() => undefined); // charged like Discover
    if (!result) return;
    if (!result.ok) {
      setAnalysis({
        status: 'error',
        kind: 'refresh',
        error: describeError(result.error, 'Analysis failed'),
      });
      return;
    }
    const value = result.value;
    setCandidates(value.candidates);
    setUnavailable(value.unavailable);
    setAnalysis({
      status: 'done',
      kind: 'refresh',
      summary: summarizeRefresh(value, system.repositories.length),
      raw: value,
      finishedAt: new Date().toISOString(),
    });
    const scope = scopeRef.current;
    listRelationships(system.id)
      .then((list) => {
        if (scope === scopeRef.current) setRelationships(list);
      })
      .catch(() => undefined);
  }

  async function onDiscover() {
    if (!selected) return;
    const system = selected;
    setAnalysis({ status: 'running', kind: 'discover' });
    const result = await exclusive('discover', () => discoverRelationships(system.id));
    // Each scan is charged: re-read the workspace usage counter (does not change workspace).
    refreshWorkspace().catch(() => undefined);
    if (!result) return;
    if (!result.ok) {
      setAnalysis({
        status: 'error',
        kind: 'discover',
        error: describeError(result.error, 'Discovery failed'),
      });
      return;
    }
    const value = result.value;
    setRelationships(value.relationships);
    setRelationshipsLoaded(true);
    setRelationshipsError(null);
    setCandidates(value.candidates);
    setAnalysis({
      status: 'done',
      kind: 'discover',
      summary: summarizeDiscovery(value, system.repositories.length),
      raw: value,
      finishedAt: new Date().toISOString(),
    });
  }

  // ── systems & repositories ────────────────────────────────────────────────

  async function onCreate(input: { name: string; owner: string; repository: string }) {
    const result = await exclusive('mutate', () =>
      createSystem({
        name: input.name,
        primaryOwner: input.owner,
        primaryRepository: input.repository,
      }),
    );
    if (!result) return null;
    if (!result.ok) return describeError(result.error, 'System could not be created');
    setDialog(null);
    notify.success(`Created “${result.value.name}”`);
    await loadSystems(result.value.id);
    return null;
  }

  async function onAddRepository(input: {
    owner: string;
    repository: string;
    role: MultiRepoRepositoryRole;
    enabled: boolean;
  }) {
    if (!selected) return null;
    const systemId = selected.id;
    const result = await exclusive('mutate', () =>
      addSystemRepository(systemId, { ...input, source: 'user_selected' }),
    );
    if (!result) return null;
    if (!result.ok) return describeError(result.error, 'Repository could not be added');
    replaceSystem(result.value);
    setDialog(null);
    notify.success(`Added ${input.owner}/${input.repository}`);
    return null;
  }

  async function onAcceptCandidate(candidate: RelatedRepositoryCandidate) {
    if (!selected) return;
    const systemId = selected.id;
    const result = await exclusive('mutate', () =>
      addSystemRepository(systemId, {
        owner: candidate.repository.owner,
        repository: candidate.repository.repository,
        role: 'unknown',
        enabled: true,
        source: 'deterministic_link',
      }),
    );
    if (!result) return;
    if (!result.ok) {
      const error = describeError(result.error, 'Repository could not be added');
      notify.apiError(error.title, result.error);
      return;
    }
    replaceSystem(result.value);
    setCandidates(
      (prev) => prev?.filter((c) => candidateKey(c) !== candidateKey(candidate)) ?? prev,
    );
    notify.success(`Added ${repoLabel(candidate.repository)}`);
  }

  function onDismissCandidate(candidate: RelatedRepositoryCandidate) {
    const key = candidateKey(candidate);
    setDismissed((prev) => (prev.includes(key) ? prev : [...prev, key]));
  }

  async function onUpdateRepository(
    ref: ProjectSystemRepositoryRef,
    patch: { role: MultiRepoRepositoryRole; enabled: boolean },
    errorTitle: string,
  ) {
    if (!selected) return;
    const systemId = selected.id;
    const result = await exclusive('mutate', () =>
      updateSystemRepository(systemId, ref.repository.owner, ref.repository.repository, patch),
    );
    if (!result) return;
    if (result.ok) {
      replaceSystem(result.value);
    } else {
      notify.apiError(errorTitle, result.error);
      await loadSystems(systemId);
    }
  }

  async function onConfirmRemove() {
    if (!selected || !removing) return;
    const systemId = selected.id;
    const target = removing;
    const result = await exclusive('mutate', () =>
      removeSystemRepository(systemId, target.repository.owner, target.repository.repository),
    );
    if (!result) return;
    setRemoving(null);
    if (!result.ok) {
      notify.apiError('Repository could not be removed', result.error);
      return;
    }
    replaceSystem(result.value);
    notify.success(`Removed ${repoLabel(target.repository)}`);
    const scope = scopeRef.current;
    listRelationships(systemId)
      .then((list) => {
        if (scope === scopeRef.current) setRelationships(list);
      })
      .catch(() => undefined);
  }

  async function onRename(name: string) {
    if (!selected) return null;
    const systemId = selected.id;
    const result = await exclusive('mutate', () => updateSystem(systemId, { name }));
    if (!result) return null;
    if (!result.ok) return describeError(result.error, 'System could not be renamed');
    replaceSystem(result.value);
    setDialog(null);
    notify.success('System renamed');
    return null;
  }

  async function onDelete() {
    if (!selected) return null;
    const system = selected;
    const result = await exclusive('mutate', () => deleteSystem(system.id));
    if (!result) return null;
    if (!result.ok) return describeError(result.error, 'System could not be deleted');
    setDialog(null);
    notify.success(`Deleted “${system.name}”`);
    setSelectedId(null);
    await loadSystems(null);
    return null;
  }

  // ── render ────────────────────────────────────────────────────────────────

  const header = (
    <header className="rise-in space-y-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-accent">
            Multi-repo
          </p>
          <h1 className="mt-2 font-display text-4xl font-semibold tracking-tight text-ink">
            Systems
          </h1>
          <p className="mt-2 text-base text-ink">Understand how your repositories work together.</p>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Group repositories into a system to discover dependencies and analyze changes across
            services.
          </p>
        </div>
        {systems && systems.length > 0 ? (
          <button
            type="button"
            disabled={operation !== null || featureMissing}
            onClick={() => setDialog('create')}
            className={BUTTON_PRIMARY}
          >
            Create system
          </button>
        ) : null}
      </div>
      <dl className="grid gap-2 text-xs sm:grid-cols-3">
        {[
          ['Repository', 'One GitHub repository you can access.'],
          ['System', 'A group of repositories that work together, e.g. a web app and its APIs.'],
          ['Relationship', 'A dependency Project X found between two repositories, with evidence.'],
        ].map(([term, definition]) => (
          <div key={term} className="rounded-2xl border border-line/80 bg-panel/50 px-3 py-2">
            <dt className="font-semibold text-ink">{term}</dt>
            <dd className="mt-0.5 text-muted-foreground">{definition}</dd>
          </div>
        ))}
      </dl>
    </header>
  );

  let body: React.ReactNode;
  if (loadError) {
    body = (
      <Callout
        tone="error"
        role="alert"
        title={loadError.title}
        action={
          <button type="button" onClick={() => void loadSystems()} className={BUTTON_PRIMARY}>
            Try again
          </button>
        }
      >
        {loadError.message}
      </Callout>
    );
  } else if (systems === null) {
    body = (
      <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner /> Loading systems…
      </p>
    );
  } else if (systems.length === 0 || !selected) {
    body = (
      <EmptyState
        title="Create your first system"
        description="Pick a primary repository — usually the main app or service — then add the repositories it depends on. Project X can then find dependencies between them. Nothing changes in GitHub."
        action={
          <button
            type="button"
            disabled={featureMissing}
            onClick={() => setDialog('create')}
            className={BUTTON_PRIMARY}
          >
            Create system
          </button>
        }
      />
    );
  } else {
    body = (
      <div className="space-y-5">
        <SystemSelectorCard
          systems={systems}
          selected={selected}
          operation={operation}
          lastValidated={lastValidatedAt(relationships)}
          usage={usage}
          analysisBlocked={analysisBlocked}
          onSelect={setSelectedId}
          onRefresh={() => void onRefresh()}
          onDiscover={() => void onDiscover()}
          onOpenSettings={() => setDialog('settings')}
        />
        <AnalysisResult
          state={analysis}
          onRetry={() =>
            void (analysis.status === 'error' && analysis.kind === 'discover'
              ? onDiscover()
              : onRefresh())
          }
          onAddRepository={() => setDialog('add')}
          onDismiss={() => setAnalysis({ status: 'idle' })}
        />
        <SystemOverview
          system={selected}
          relationshipCount={relationships.filter((r) => r.status === 'active').length}
          relationshipsLoaded={relationshipsLoaded && !relationshipsError}
          candidateCount={visibleCandidates?.length ?? null}
          unavailableCount={unavailable?.length ?? null}
        />
        <RepositoryList
          system={selected}
          operation={operation}
          onAdd={() => setDialog('add')}
          onToggleEnabled={(ref) =>
            void onUpdateRepository(
              ref,
              { role: ref.role, enabled: !ref.enabled },
              'Repository could not be updated',
            )
          }
          onChangeRole={(ref, role) =>
            void onUpdateRepository(
              ref,
              { role, enabled: ref.enabled },
              'Repository role could not be updated',
            )
          }
          onRemove={setRemoving}
        />
        <div className="grid gap-5 xl:grid-cols-2">
          {relationshipsError ? (
            <Callout tone="error" role="alert" title={relationshipsError.title}>
              {relationshipsError.message}
            </Callout>
          ) : (
            <RelationshipList
              relationships={relationships}
              loaded={relationshipsLoaded}
              analyzed={candidates !== null}
              operation={operation}
              onAnalyze={() => void onRefresh()}
            />
          )}
          <CandidateList
            candidates={visibleCandidates ?? []}
            analyzed={visibleCandidates !== null}
            operation={operation}
            onAccept={(c) => void onAcceptCandidate(c)}
            onDismiss={onDismissCandidate}
            onRefresh={() => void onRefresh()}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {header}
      {featureMissing ? (
        <Callout
          title="Systems are not included in your current plan"
          action={
            <Link href="/app/billing" className={BUTTON_SECONDARY}>
              View plans
            </Link>
          }
        >
          You can view existing systems, but creating systems and running analyses need a plan that
          includes multi-repository analysis.
        </Callout>
      ) : null}
      {githubConnected === false ? <GithubConnectionNotice /> : null}
      <div className="rise-in-delay-1">{body}</div>

      <CreateSystemDialog
        open={dialog === 'create'}
        onClose={() => setDialog(null)}
        onSubmit={onCreate}
      />
      <AddRepositoryDialog
        open={dialog === 'add'}
        system={selected}
        onClose={() => setDialog(null)}
        onSubmit={onAddRepository}
      />
      <SystemSettingsDialog
        open={dialog === 'settings'}
        system={selected}
        onClose={() => setDialog(null)}
        onRename={onRename}
        onDelete={onDelete}
      />
      <ConfirmRemoveDialog
        repository={removing ? repoLabel(removing.repository) : null}
        pending={operation === 'mutate'}
        onCancel={() => setRemoving(null)}
        onConfirm={() => void onConfirmRemove()}
      />
    </div>
  );
}
