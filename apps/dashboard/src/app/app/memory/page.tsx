'use client';

import { type FormEvent, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import type {
  ProjectMemoryCandidate,
  ProjectMemoryCategory,
  ProjectMemoryConfidence,
  ProjectMemoryItem,
  ProjectProfile,
} from '@project-x/types';
import {
  ProjectMemoryCategory as Categories,
  PROJECT_MEMORY_MAX_SUMMARY_CHARS,
} from '@project-x/types';
import { EXPLICIT_PROJECT_RULE_CATEGORIES, safeErrorMessage } from '@project-x/shared';

import {
  ApiError,
  clearProjectMemory,
  confirmMemoryCandidate,
  createProjectMemoryRule,
  isWorkspaceSelectionError,
  learnProjectMemory,
  rejectMemoryCandidate,
  updateProjectMemory,
} from '../../../lib/api';
import { StudioSelect } from '../../../components/studio-select';
import { fetchMemory, memorySourceLabel } from './memory-data';
import { runMemoryMutation, WORKSPACE_SELECTION_MESSAGE } from './memory-notifications';
import { useWorkspace } from '../../../lib/workspace-context';
import { MemoryActivity } from './memory-activity';

const CATEGORY_LABELS: Record<ProjectMemoryCategory, string> = {
  ARCHITECTURE: 'Architecture',
  FRAMEWORK: 'Framework',
  CODE_CONVENTION: 'Code convention',
  NAMING_CONVENTION: 'Naming',
  ERROR_HANDLING: 'Error handling',
  API_CONVENTION: 'API',
  DATABASE_CONVENTION: 'Database',
  TESTING_CONVENTION: 'Testing',
  STATE_MANAGEMENT: 'State',
  SECURITY_CONVENTION: 'Security',
  CI_CONVENTION: 'CI',
  DEPLOYMENT_CONVENTION: 'Deployment',
  REVIEW_CONVENTION: 'Review',
  PROJECT_CONSTRAINT: 'Constraint',
  TECHNICAL_DECISION: 'Decision',
  USER_PREFERENCE: 'Preference',
  SERVICE_RESPONSIBILITY: 'Service',
  DIRECTORY_CONVENTION: 'Directory',
  DEPENDENCY_CONVENTION: 'Dependency',
};

const CONFIDENCE_STYLES: Record<ProjectMemoryConfidence, string> = {
  high: 'border-accent bg-accent-soft text-ink',
  medium: 'border-line bg-mist text-ink',
  low: 'border-line bg-panel text-muted-foreground',
};

/** Same (category, key, scope) slot — reactivating supersedes the rule currently in it. */
function sameSlot(a: ProjectMemoryItem, b: ProjectMemoryItem): boolean {
  return (
    a.category === b.category &&
    a.key === b.key &&
    JSON.stringify(a.scope) === JSON.stringify(b.scope)
  );
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString();
}

/** Same limit the API enforces for rule text (PROJECT_MEMORY_MAX_SUMMARY_CHARS). */
const RULE_TEXT_MAX_CHARS = PROJECT_MEMORY_MAX_SUMMARY_CHARS;

/**
 * Client-side pre-check of an edited rule (the server re-validates everything, including the
 * safety policy). Returns 'unchanged', an error message, or null when it can be saved.
 */
function ruleEditProblem(original: string, next: string): string | null {
  if (next === original.trim()) return 'unchanged';
  if (next.length === 0) return 'Rule text is required.';
  if (next.length > RULE_TEXT_MAX_CHARS) {
    return `Rule text must be at most ${RULE_TEXT_MAX_CHARS} characters.`;
  }
  return null;
}

/** Shared rules need memory:manage; personal preferences belong to their author. */
function isPersonalItem(item: { category: ProjectMemoryCategory }): boolean {
  return item.category === Categories.USER_PREFERENCE;
}

function formatCategory(category: ProjectMemoryCategory): string {
  return CATEGORY_LABELS[category] ?? category.replaceAll('_', ' ').toLowerCase();
}

function groupByCategory(
  items: ProjectMemoryItem[],
): [ProjectMemoryCategory, ProjectMemoryItem[]][] {
  const map = new Map<ProjectMemoryCategory, ProjectMemoryItem[]>();
  for (const item of items) {
    const list = map.get(item.category) ?? [];
    list.push(item);
    map.set(item.category, list);
  }
  return Array.from(map.entries()).sort(([a], [b]) =>
    formatCategory(a).localeCompare(formatCategory(b)),
  );
}

function profileChipCounts(profile: ProjectProfile | null): { label: string; count: number }[] {
  if (!profile) {
    return [
      { label: 'Architecture', count: 0 },
      { label: 'Testing', count: 0 },
      { label: 'Tooling', count: 0 },
    ];
  }
  const testing = profile.conventions.filter(
    (item) => item.category === Categories.TESTING_CONVENTION,
  ).length;
  return [
    { label: 'Architecture', count: profile.architecture.length },
    { label: 'Testing', count: testing },
    { label: 'Tooling', count: profile.tooling.length },
  ];
}

function MemoryPageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  // UI gating only — the API enforces the same permissions.
  const {
    hasPermission,
    refresh: refreshWorkspace,
    currentWorkspaceId,
    workspaceRevision,
  } = useWorkspace();
  const canManage = hasPermission('memory:manage');
  const [owner, setOwner] = useState(() => searchParams.get('owner')?.trim() ?? '');
  const [repo, setRepo] = useState(() => searchParams.get('repo')?.trim() ?? '');
  const [items, setItems] = useState<ProjectMemoryItem[]>([]);
  const [archivedItems, setArchivedItems] = useState<ProjectMemoryItem[]>([]);
  const [disputedItems, setDisputedItems] = useState<ProjectMemoryItem[]>([]);
  const [confirmReactivateId, setConfirmReactivateId] = useState<string | null>(null);
  /** Rule whose history the Activity section shows (null = all activity). */
  const [historyRule, setHistoryRule] = useState<{ id: string; key: string } | null>(null);
  const [profile, setProfile] = useState<ProjectProfile | null>(null);
  const [candidates, setCandidates] = useState<ProjectMemoryCandidate[]>([]);
  const [memoryVersion, setMemoryVersion] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [learning, setLearning] = useState(false);
  const [creating, setCreating] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  /** Inline rule editor: the rule being edited, its draft text and an inline error. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [ruleText, setRuleText] = useState('');
  const [ruleCategory, setRuleCategory] = useState<ProjectMemoryCategory>(
    Categories.USER_PREFERENCE,
  );
  const [clearConfirm, setClearConfirm] = useState(false);
  const [showClearDialog, setShowClearDialog] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ownerTrimmed = owner.trim();
  const repoTrimmed = repo.trim();
  const canQuery = ownerTrimmed.length > 0 && repoTrimmed.length > 0;

  const activeItems = useMemo(() => items.filter((item) => item.status === 'active'), [items]);
  const grouped = useMemo(() => groupByCategory(activeItems), [activeItems]);
  const chips = useMemo(() => profileChipCounts(profile), [profile]);

  /**
   * The API rejected the selected workspace (stale, removed, or invalid) instead of silently
   * using another one. Re-bootstrap so the switcher reflects a workspace the user can access.
   */
  const onWorkspaceSelectionError = useCallback(() => {
    setError(WORKSPACE_SELECTION_MESSAGE);
    void refreshWorkspace().catch(() => undefined);
  }, [refreshWorkspace]);

  const onLoadError = useCallback(
    (err: unknown) => {
      if (isWorkspaceSelectionError(err)) {
        onWorkspaceSelectionError();
        return;
      }
      setError(safeErrorMessage(err, 'Unable to load project memory.'));
    },
    [onWorkspaceSelectionError],
  );

  useEffect(() => {
    const qOwner = searchParams.get('owner')?.trim() ?? '';
    const qRepo = searchParams.get('repo')?.trim() ?? '';
    if (!qOwner || !qRepo) {
      return;
    }

    let cancelled = false;

    async function loadFromQuery() {
      setLoading(true);
      setError(null);
      try {
        const next = await fetchMemory(qOwner, qRepo);
        if (cancelled) {
          return;
        }
        setItems(next.list.items);
        setArchivedItems(next.archived);
        setDisputedItems(next.disputed);
        setMemoryVersion(next.list.memoryVersion);
        setProfile(next.profile);
        setLoaded(true);
      } catch (err) {
        if (!cancelled) {
          setLoaded(true);
          setItems([]);
          setArchivedItems([]);
          setDisputedItems([]);
          setProfile(null);
          setMemoryVersion(null);
          onLoadError(err);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadFromQuery();
    return () => {
      cancelled = true;
    };
  }, [searchParams, onLoadError]);

  const syncRepoToUrl = useCallback(
    (nextOwner: string, nextRepo: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set('owner', nextOwner);
      params.set('repo', nextRepo);
      const query = params.toString();
      router.replace(query ? `/app/memory?${query}` : '/app/memory');
    },
    [router, searchParams],
  );

  const refresh = useCallback(async () => {
    if (!canQuery) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const next = await fetchMemory(ownerTrimmed, repoTrimmed);
      setItems(next.list.items);
      setArchivedItems(next.archived);
      setDisputedItems(next.disputed);
      setMemoryVersion(next.list.memoryVersion);
      setProfile(next.profile);
      setLoaded(true);
      syncRepoToUrl(ownerTrimmed, repoTrimmed);
    } catch (err) {
      setLoaded(true);
      setItems([]);
      setArchivedItems([]);
      setDisputedItems([]);
      setProfile(null);
      setMemoryVersion(null);
      onLoadError(err);
    } finally {
      setLoading(false);
    }
  }, [canQuery, ownerTrimmed, repoTrimmed, syncRepoToUrl, onLoadError]);

  /** Error hooks shared by every mutation (see memory-notifications.ts). */
  const errorHooks = {
    onWorkspaceSelection: () => {
      void refreshWorkspace().catch(() => undefined);
    },
    onForbidden: () => {
      void refreshWorkspace();
    },
  };
  const repoLabel = `${ownerTrimmed}/${repoTrimmed}`;

  function showHistory(item: ProjectMemoryItem) {
    setHistoryRule({ id: item.id, key: item.key });
    if (typeof document !== 'undefined') {
      document.getElementById('memory-activity-heading')?.scrollIntoView({ behavior: 'smooth' });
    }
  }

  // Activity follows the repository that is loaded (synced to the URL), not the input fields.
  const loadedOwner = searchParams.get('owner')?.trim() ?? '';
  const loadedRepo = searchParams.get('repo')?.trim() ?? '';

  useEffect(() => {
    // A rule id from another workspace or repository must not stay selected.
    setHistoryRule(null);
  }, [workspaceRevision, loadedOwner, loadedRepo]);

  async function onLoad(event?: FormEvent) {
    event?.preventDefault();
    if (!canQuery) {
      setError('Enter both owner and repository.');
      return;
    }
    await refresh();
  }

  async function onLearn() {
    if (!canQuery) {
      setError('Enter both owner and repository.');
      return;
    }
    setLearning(true);
    setError(null);
    const outcome = await runMemoryMutation(() => learnProjectMemory(ownerTrimmed, repoTrimmed), {
      ...errorHooks,
      loading: 'Learning project context…',
      success: (result) =>
        result.accepted.length > 0
          ? {
              title: `Learned ${result.accepted.length} fact${result.accepted.length === 1 ? '' : 's'}`,
              description:
                result.candidates.length > 0
                  ? 'Review the suggested candidates below.'
                  : `Saved to ${repoLabel}.`,
            }
          : {
              title: 'Learn finished',
              description:
                result.candidates.length > 0
                  ? 'Review the suggested candidates below.'
                  : (result.disputedSkipped?.length ?? 0) > 0
                    ? `${result.disputedSkipped!.length} disputed fact${result.disputedSkipped!.length === 1 ? ' was' : 's were'} not re-added.`
                    : 'No new project facts were found.',
            },
      errorTitle: 'Could not learn project context',
    });
    if (outcome.ok) {
      setCandidates(outcome.value.candidates);
      if (outcome.value.profile) {
        setProfile(outcome.value.profile);
      }
      setMemoryVersion(outcome.value.memoryVersion);
      await refresh();
    }
    setLearning(false);
  }

  async function onCreateRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canQuery || ruleText.trim().length === 0) {
      return;
    }
    const personal = ruleCategory === Categories.USER_PREFERENCE;
    setCreating(true);
    setError(null);
    const outcome = await runMemoryMutation(
      () =>
        createProjectMemoryRule(ownerTrimmed, repoTrimmed, {
          category: ruleCategory,
          text: ruleText.trim(),
        }),
      {
        ...errorHooks,
        success: personal
          ? {
              title: 'Preference saved',
              description: 'Only you see it; it applies to your AI reviews.',
            }
          : { title: 'Rule saved', description: `Applies to future AI reviews of ${repoLabel}.` },
        errorTitle: personal ? 'Could not save preference' : 'Could not save rule',
      },
    );
    if (outcome.ok) {
      setRuleText('');
      await refresh();
    }
    setCreating(false);
  }

  async function onStatus(item: ProjectMemoryItem, status: 'archived' | 'disputed') {
    if (!canQuery) {
      return;
    }
    setBusyId(item.id);
    setError(null);
    const outcome = await runMemoryMutation(
      () => updateProjectMemory(ownerTrimmed, repoTrimmed, item.id, { status }),
      {
        ...errorHooks,
        success:
          status === 'archived'
            ? {
                title: 'Rule archived',
                description: 'It no longer applies to AI reviews. Reactivate it from Archived.',
              }
            : {
                title: 'Rule marked disputed',
                description: 'It no longer applies to AI reviews.',
              },
        errorTitle: status === 'archived' ? 'Could not archive rule' : 'Could not dispute rule',
      },
    );
    if (outcome.ok) {
      await refresh();
    }
    setBusyId(null);
  }

  function startEdit(item: ProjectMemoryItem) {
    setEditingId(item.id);
    setEditDraft(item.value.summary);
    setEditError(null);
  }

  function cancelEdit() {
    setEditingId(null);
    setEditDraft('');
    setEditError(null);
  }

  /**
   * Save edited rule text. The API re-checks role / authorship and applies the same
   * validation and safety policy as creating a rule; `expectedUpdatedAt` makes a concurrent
   * change a 409 instead of a silent overwrite. Validation (400) and conflicts (409) stay
   * inline next to the draft; everything else is a notification.
   */
  async function onSaveEdit(item: ProjectMemoryItem) {
    if (!canQuery) {
      return;
    }
    const text = editDraft.trim();
    const problem = ruleEditProblem(item.value.summary, text);
    if (problem === 'unchanged') {
      cancelEdit();
      return;
    }
    if (problem) {
      setEditError(problem);
      return;
    }
    setBusyId(item.id);
    setEditError(null);
    setError(null);
    const isInline = (err: unknown) =>
      err instanceof ApiError && (err.statusCode === 400 || err.statusCode === 409);
    const outcome = await runMemoryMutation(
      () =>
        updateProjectMemory(ownerTrimmed, repoTrimmed, item.id, {
          text,
          expectedUpdatedAt: item.updatedAt,
        }),
      {
        ...errorHooks,
        success: 'Rule updated',
        errorTitle: 'Could not update rule',
        handledInline: isInline,
      },
    );
    if (outcome.ok) {
      // Show the saved rule right away, then resync the full list (and memory version).
      const updated = outcome.value;
      setItems((prev) => prev.map((row) => (row.id === updated.id ? updated : row)));
      cancelEdit();
      await refresh();
    } else if (outcome.error instanceof ApiError && outcome.error.statusCode === 409) {
      // Someone else changed it: load their version, keep this draft for a second look.
      setEditError(
        `${safeErrorMessage(outcome.error)} Your draft is kept — compare it with the reloaded rule and save again.`,
      );
      await refresh();
    } else if (isInline(outcome.error)) {
      setEditError(safeErrorMessage(outcome.error));
    } else {
      cancelEdit();
      if (outcome.error instanceof ApiError && outcome.error.statusCode === 404) {
        await refresh();
      }
    }
    setBusyId(null);
  }

  /**
   * Archived / disputed → active. The API re-checks role (shared rules) or authorship
   * (preferences), re-applies the safety policy to the stored text and the rule limits, and
   * supersedes whatever rule currently holds the same slot.
   */
  async function onReactivate(item: ProjectMemoryItem) {
    if (!canQuery || (item.status !== 'archived' && item.status !== 'disputed')) {
      return;
    }
    const disputed = item.status === 'disputed';
    setBusyId(item.id);
    setError(null);
    const outcome = await runMemoryMutation(
      () => updateProjectMemory(ownerTrimmed, repoTrimmed, item.id, { status: 'active' }),
      {
        ...errorHooks,
        success: {
          title: disputed ? 'Disputed rule restored' : 'Rule reactivated',
          description: 'It applies to AI reviews again.',
        },
        errorTitle: disputed ? 'Could not restore rule' : 'Could not reactivate rule',
      },
    );
    setConfirmReactivateId(null);
    if (outcome.ok) {
      await refresh();
    }
    setBusyId(null);
  }

  /** Disputed → archived: keeps the rule out of AI context and out of the review queue. */
  async function onArchiveDisputed(item: ProjectMemoryItem) {
    if (!canQuery || item.status !== 'disputed') {
      return;
    }
    setBusyId(item.id);
    setError(null);
    const outcome = await runMemoryMutation(
      () => updateProjectMemory(ownerTrimmed, repoTrimmed, item.id, { status: 'archived' }),
      {
        ...errorHooks,
        success: {
          title: 'Disputed rule archived',
          description: 'It stays out of AI reviews and is listed under Archived.',
        },
        errorTitle: 'Could not archive rule',
      },
    );
    if (outcome.ok) {
      await refresh();
    }
    setBusyId(null);
  }

  async function onClear() {
    if (!canQuery || !clearConfirm) {
      return;
    }
    setClearing(true);
    setError(null);
    const outcome = await runMemoryMutation(() => clearProjectMemory(ownerTrimmed, repoTrimmed), {
      ...errorHooks,
      loading: 'Clearing project memory…',
      success: (result) => ({
        title: `Cleared ${result.archived} rule${result.archived === 1 ? '' : 's'}`,
        description: 'Archived rules can be reactivated from Archived.',
      }),
      errorTitle: 'Could not clear project memory',
    });
    if (outcome.ok) {
      setCandidates([]);
      setClearConfirm(false);
      setShowClearDialog(false);
      await refresh();
    }
    setClearing(false);
  }

  async function onRemember(candidate: ProjectMemoryCandidate) {
    if (!canQuery) {
      return;
    }
    setBusyId(candidate.id);
    setError(null);
    const outcome = await runMemoryMutation(
      () => confirmMemoryCandidate(ownerTrimmed, repoTrimmed, candidate.id),
      { ...errorHooks, success: 'Candidate remembered', errorTitle: 'Could not save candidate' },
    );
    if (outcome.ok) {
      setCandidates((prev) => prev.filter((c) => c.id !== candidate.id));
      await refresh();
    }
    setBusyId(null);
  }

  async function onReject(candidate: ProjectMemoryCandidate) {
    if (!canQuery) {
      return;
    }
    setBusyId(candidate.id);
    setError(null);
    const outcome = await runMemoryMutation(
      () => rejectMemoryCandidate(ownerTrimmed, repoTrimmed, candidate.id),
      { ...errorHooks, success: 'Candidate dismissed', errorTitle: 'Could not dismiss candidate' },
    );
    if (outcome.ok) {
      setCandidates((prev) => prev.filter((c) => c.id !== candidate.id));
    }
    setBusyId(null);
  }

  // Members may only save personal preferences; shared categories need memory:manage.
  const categoryOptions = useMemo(
    () =>
      EXPLICIT_PROJECT_RULE_CATEGORIES.filter(
        (category) => canManage || category === Categories.USER_PREFERENCE,
      ).map((category) => ({
        value: category,
        label: formatCategory(category),
      })),
    [canManage],
  );

  useEffect(() => {
    if (!canManage && ruleCategory !== Categories.USER_PREFERENCE) {
      setRuleCategory(Categories.USER_PREFERENCE);
    }
  }, [canManage, ruleCategory]);

  const emptyLearned = loaded && !loading && activeItems.length === 0 && !error;

  return (
    <div className="space-y-8">
      <header className="rise-in">
        <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-accent">
          Project context
        </p>
        <h1 className="mt-2 font-display text-4xl font-semibold tracking-tight text-ink">Memory</h1>
        <p className="mt-3 max-w-xl text-base text-muted-foreground">
          Review learned architecture, conventions, and rules for a GitHub repository. Prefer
          explicit project rules over noisy auto-accepts.
        </p>
      </header>

      <section className="rise-in-delay-1 space-y-3">
        <h2 className="px-1 font-display text-lg font-semibold tracking-tight">Repository</h2>
        <form
          onSubmit={onLoad}
          className="overflow-hidden rounded-3xl border border-line bg-panel/75 shadow-panel"
        >
          <div className="grid gap-4 border-b border-line/80 px-5 py-4 sm:grid-cols-2">
            <div>
              <label htmlFor="memory-owner" className="text-sm font-semibold text-ink">
                Owner
              </label>
              <input
                id="memory-owner"
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder="octocat"
                value={owner}
                onChange={(event) => setOwner(event.target.value)}
                className="mt-2 w-full rounded-xl border border-line bg-mist px-3 py-2.5 font-mono text-sm text-ink outline-none ring-accent/30 focus:ring-2"
              />
            </div>
            <div>
              <label htmlFor="memory-repo" className="text-sm font-semibold text-ink">
                Repository
              </label>
              <input
                id="memory-repo"
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder="hello-world"
                value={repo}
                onChange={(event) => setRepo(event.target.value)}
                className="mt-2 w-full rounded-xl border border-line bg-mist px-3 py-2.5 font-mono text-sm text-ink outline-none ring-accent/30 focus:ring-2"
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3 bg-mist/50 px-5 py-4">
            <button
              type="submit"
              disabled={loading || !canQuery}
              className="rounded-xl bg-ink px-4 py-2.5 text-sm font-semibold text-inverse transition hover:opacity-90 disabled:opacity-50"
            >
              {loading ? 'Loading…' : 'Load memory'}
            </button>
            <button
              type="button"
              disabled={learning || !canQuery || !canManage}
              title={
                canManage
                  ? undefined
                  : 'Only workspace Owners and Admins can learn project context.'
              }
              onClick={() => {
                void onLearn();
              }}
              className="rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-accent-foreground shadow-soft transition hover:brightness-110 disabled:opacity-50"
            >
              {learning ? 'Learning…' : 'Learn Project Context'}
            </button>
            {memoryVersion ? (
              <p className="text-xs text-muted-foreground">Version {memoryVersion}</p>
            ) : null}
          </div>
        </form>
      </section>

      {error && (
        <div className="rise-in-delay-1 space-y-1 px-1">
          {error ? <p className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
        </div>
      )}

      <section className="rise-in-delay-1 space-y-3">
        <h2 className="px-1 font-display text-lg font-semibold tracking-tight">Profile</h2>
        <div className="flex flex-wrap gap-2">
          {chips.map((chip) => (
            <span
              key={chip.label}
              className="inline-flex items-center gap-2 rounded-xl border border-line bg-panel/75 px-3 py-1.5 text-xs font-semibold text-ink shadow-panel"
            >
              {chip.label}
              <span className="rounded-lg bg-accent-soft px-1.5 py-0.5 text-[11px] text-ink">
                {chip.count}
              </span>
            </span>
          ))}
        </div>
      </section>

      <section className="rise-in-delay-2 space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3 px-1">
          <h2 className="font-display text-lg font-semibold tracking-tight">Active memory</h2>
          <p className="text-xs text-muted-foreground">
            {activeItems.length} active item{activeItems.length === 1 ? '' : 's'}
          </p>
        </div>

        {loading && !loaded ? (
          <div className="rounded-3xl border border-line bg-panel/75 px-5 py-8 text-sm text-muted-foreground shadow-panel">
            Loading memory…
          </div>
        ) : emptyLearned ? (
          <div className="rounded-3xl border border-dashed border-line bg-panel/75 px-5 py-8 shadow-panel">
            <p className="font-display text-lg font-semibold text-ink">No project context yet</p>
            <p className="mt-2 max-w-lg text-sm text-muted-foreground">
              Project X can remember repository conventions and rules to make future reviews more
              relevant. Learn project context when you are ready.
            </p>
          </div>
        ) : grouped.length > 0 ? (
          <div className="space-y-4">
            {grouped.map(([category, categoryItems]) => (
              <div
                key={category}
                className="overflow-hidden rounded-3xl border border-line bg-panel/75 shadow-panel"
              >
                <div className="border-b border-line/80 px-5 py-3">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                    {formatCategory(category)}
                  </p>
                </div>
                <ul className="divide-y divide-line/80">
                  {categoryItems.map((item) => (
                    <li
                      key={item.id}
                      className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start sm:justify-between"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-semibold text-ink">{item.key}</p>
                          <button
                            type="button"
                            onClick={() => showHistory(item)}
                            aria-label={`History of ${item.key}`}
                            className="rounded-lg px-1.5 py-0.5 text-[11px] font-semibold text-accent hover:underline"
                          >
                            History
                          </button>
                          <span
                            className={[
                              'rounded-lg border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                              CONFIDENCE_STYLES[item.confidence],
                            ].join(' ')}
                          >
                            {item.confidence}
                          </span>
                        </div>
                        {editingId === item.id ? (
                          <div className="mt-2 space-y-2">
                            <label htmlFor={`edit-rule-${item.id}`} className="sr-only">
                              Rule text
                            </label>
                            <textarea
                              id={`edit-rule-${item.id}`}
                              value={editDraft}
                              maxLength={RULE_TEXT_MAX_CHARS}
                              rows={3}
                              autoFocus
                              onChange={(event) => {
                                setEditDraft(event.target.value);
                                setEditError(null);
                              }}
                              onKeyDown={(event) => {
                                if (event.key === 'Escape') cancelEdit();
                              }}
                              className="w-full rounded-xl border border-line bg-panel px-3 py-2 text-sm text-ink outline-none focus:border-accent"
                            />
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="text-xs text-muted-foreground">
                                {editDraft.trim().length}/{RULE_TEXT_MAX_CHARS}
                              </span>
                              <div className="flex gap-2">
                                <button
                                  type="button"
                                  disabled={busyId === item.id}
                                  onClick={cancelEdit}
                                  className="rounded-xl border border-line bg-panel px-3 py-1.5 text-xs font-semibold text-ink transition hover:bg-mist disabled:opacity-50"
                                >
                                  Cancel
                                </button>
                                <button
                                  type="button"
                                  disabled={busyId === item.id || editDraft.trim().length === 0}
                                  onClick={() => {
                                    void onSaveEdit(item);
                                  }}
                                  className="rounded-xl bg-ink px-3 py-1.5 text-xs font-semibold text-panel transition hover:opacity-90 disabled:opacity-50"
                                >
                                  {busyId === item.id ? 'Saving…' : 'Save'}
                                </button>
                              </div>
                            </div>
                            {editError ? (
                              <p role="alert" className="text-xs text-red-600 dark:text-red-400">
                                {editError}
                              </p>
                            ) : null}
                          </div>
                        ) : (
                          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                            {item.value.summary}
                          </p>
                        )}
                      </div>
                      {editingId === item.id ? null : canManage || isPersonalItem(item) ? (
                        <div className="flex shrink-0 flex-wrap gap-2">
                          <button
                            type="button"
                            disabled={
                              busyId === item.id || (editingId !== null && editingId !== item.id)
                            }
                            onClick={() => startEdit(item)}
                            className="rounded-xl border border-line bg-panel px-3 py-1.5 text-xs font-semibold text-ink transition hover:bg-mist disabled:opacity-50"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            disabled={busyId === item.id}
                            onClick={() => {
                              void onStatus(item, 'archived');
                            }}
                            className="rounded-xl border border-line bg-panel px-3 py-1.5 text-xs font-semibold text-ink transition hover:bg-mist disabled:opacity-50"
                          >
                            Archive
                          </button>
                          <button
                            type="button"
                            disabled={busyId === item.id}
                            onClick={() => {
                              void onStatus(item, 'disputed');
                            }}
                            className="rounded-xl border border-line bg-panel px-3 py-1.5 text-xs font-semibold text-ink transition hover:bg-mist disabled:opacity-50"
                          >
                            Dispute
                          </button>
                        </div>
                      ) : (
                        <p className="shrink-0 text-xs text-muted-foreground">
                          Managed by Owners and Admins
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ) : !loaded ? (
          <div className="rounded-3xl border border-dashed border-line bg-panel/40 px-5 py-8 text-sm text-muted-foreground">
            Load a repository to see active memory.
          </div>
        ) : null}
      </section>

      {loaded ? (
        <section className="rise-in-delay-2 space-y-3" aria-labelledby="disputed-memory-heading">
          <div className="flex flex-wrap items-end justify-between gap-3 px-1">
            <h2
              id="disputed-memory-heading"
              className="font-display text-lg font-semibold tracking-tight"
            >
              Disputed memory
            </h2>
            <p className="text-xs text-muted-foreground">
              {disputedItems.length} disputed item{disputedItems.length === 1 ? '' : 's'}
            </p>
          </div>

          {disputedItems.length === 0 ? (
            <div className="rounded-3xl border border-dashed border-line bg-panel/40 px-5 py-6 text-sm text-muted-foreground">
              No disputed memory. Rules marked as disputed are kept here for review and are never
              sent to AI.
            </div>
          ) : (
            <div className="overflow-hidden rounded-3xl border border-line bg-panel/75 shadow-panel">
              <p className="border-b border-line/80 px-5 py-3 text-xs text-muted-foreground">
                Disputed rules were flagged as possibly wrong. They are excluded from AI context
                until restored. Restore a rule only if it is correct; archive it to put it away.{' '}
                {canManage
                  ? 'Restoring a shared rule applies it to every workspace member again.'
                  : 'You can resolve your own preferences. Shared rules are resolved by Owners and Admins.'}
              </p>
              <ul className="divide-y divide-line/80">
                {disputedItems.map((item) => {
                  const canResolve = canManage || isPersonalItem(item);
                  const replaces = activeItems.find((active) => sameSlot(active, item));
                  const confirming = confirmReactivateId === item.id;
                  const changedOn = formatDate(item.updatedAt);
                  return (
                    <li
                      key={item.id}
                      data-testid="disputed-memory-item"
                      className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start sm:justify-between"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-semibold text-ink">{item.key}</p>
                          <button
                            type="button"
                            onClick={() => showHistory(item)}
                            aria-label={`History of ${item.key}`}
                            className="rounded-lg px-1.5 py-0.5 text-[11px] font-semibold text-accent hover:underline"
                          >
                            History
                          </button>
                          <span className="rounded-lg border border-line bg-mist px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                            {formatCategory(item.category)}
                          </span>
                          <span className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
                            Disputed
                          </span>
                          <span
                            className={[
                              'rounded-lg border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                              CONFIDENCE_STYLES[item.confidence],
                            ].join(' ')}
                          >
                            {item.confidence}
                          </span>
                        </div>
                        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                          {item.value.summary}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground/90">
                          {memorySourceLabel(item)}
                          {isPersonalItem(item) ? ' · Personal preference' : ' · Shared rule'}
                          {changedOn ? ` · Last changed ${changedOn}` : ''}
                        </p>
                        {confirming ? (
                          <div
                            role="alertdialog"
                            aria-label={`Restore ${item.key}`}
                            className="mt-3 space-y-3 rounded-2xl border border-line bg-mist/60 p-3"
                          >
                            <p className="text-sm text-ink">
                              {replaces ? (
                                <>
                                  This replaces the active rule{' '}
                                  <span className="font-semibold">“{replaces.value.summary}”</span>,
                                  which will be marked superseded.
                                </>
                              ) : isPersonalItem(item) ? (
                                'This preference will apply to your own reviews again.'
                              ) : (
                                'This rule will be included in AI context for every member of this workspace.'
                              )}
                            </p>
                            <div className="flex flex-wrap gap-2">
                              <button
                                type="button"
                                disabled={busyId === item.id}
                                onClick={() => {
                                  void onReactivate(item);
                                }}
                                className="rounded-xl bg-ink px-3 py-1.5 text-xs font-semibold text-inverse transition hover:opacity-90 disabled:opacity-50"
                              >
                                {busyId === item.id ? 'Restoring…' : 'Confirm restore'}
                              </button>
                              <button
                                type="button"
                                disabled={busyId === item.id}
                                onClick={() => setConfirmReactivateId(null)}
                                className="rounded-xl border border-line bg-panel px-3 py-1.5 text-xs font-semibold text-ink transition hover:bg-mist disabled:opacity-50"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : null}
                      </div>
                      {canResolve ? (
                        confirming ? null : (
                          <div className="flex shrink-0 flex-wrap gap-2">
                            <button
                              type="button"
                              disabled={busyId !== null}
                              onClick={() => setConfirmReactivateId(item.id)}
                              className="rounded-xl border border-line bg-panel px-3 py-1.5 text-xs font-semibold text-ink transition hover:bg-mist disabled:opacity-50"
                            >
                              Restore
                            </button>
                            <button
                              type="button"
                              disabled={busyId !== null}
                              onClick={() => {
                                void onArchiveDisputed(item);
                              }}
                              className="rounded-xl border border-line bg-panel px-3 py-1.5 text-xs font-semibold text-ink transition hover:bg-mist disabled:opacity-50"
                            >
                              Archive
                            </button>
                          </div>
                        )
                      ) : (
                        <p className="shrink-0 text-xs text-muted-foreground">
                          Managed by Owners and Admins
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </section>
      ) : null}

      {loaded ? (
        <section className="rise-in-delay-2 space-y-3" aria-labelledby="archived-memory-heading">
          <div className="flex flex-wrap items-end justify-between gap-3 px-1">
            <h2
              id="archived-memory-heading"
              className="font-display text-lg font-semibold tracking-tight"
            >
              Archived memory
            </h2>
            <p className="text-xs text-muted-foreground">
              {archivedItems.length} archived item{archivedItems.length === 1 ? '' : 's'}
            </p>
          </div>

          {archivedItems.length === 0 ? (
            <div className="rounded-3xl border border-dashed border-line bg-panel/40 px-5 py-6 text-sm text-muted-foreground">
              No archived memory. Archived rules are kept here and are never sent to AI until
              reactivated.
            </div>
          ) : (
            <div className="overflow-hidden rounded-3xl border border-line bg-panel/75 shadow-panel">
              <p className="border-b border-line/80 px-5 py-3 text-xs text-muted-foreground">
                Archived rules are excluded from AI context.{' '}
                {canManage
                  ? 'Reactivating a shared rule applies it to every workspace member again.'
                  : 'You can reactivate your own preferences. Shared rules are reactivated by Owners and Admins.'}
              </p>
              <ul className="divide-y divide-line/80">
                {archivedItems.map((item) => {
                  const canReactivate = canManage || isPersonalItem(item);
                  const replaces = activeItems.find((active) => sameSlot(active, item));
                  const confirming = confirmReactivateId === item.id;
                  const archivedOn = formatDate(item.updatedAt);
                  return (
                    <li
                      key={item.id}
                      className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start sm:justify-between"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-sm font-semibold text-ink">{item.key}</p>
                          <button
                            type="button"
                            onClick={() => showHistory(item)}
                            aria-label={`History of ${item.key}`}
                            className="rounded-lg px-1.5 py-0.5 text-[11px] font-semibold text-accent hover:underline"
                          >
                            History
                          </button>
                          <span className="rounded-lg border border-line bg-mist px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                            {formatCategory(item.category)}
                          </span>
                          <span className="rounded-lg border border-line bg-panel px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                            Archived
                          </span>
                        </div>
                        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                          {item.value.summary}
                        </p>
                        {archivedOn ? (
                          <p className="mt-1 text-xs text-muted-foreground/90">
                            Last updated {archivedOn}
                          </p>
                        ) : null}
                        {confirming ? (
                          <div
                            role="alertdialog"
                            aria-label={`Reactivate ${item.key}`}
                            className="mt-3 space-y-3 rounded-2xl border border-line bg-mist/60 p-3"
                          >
                            <p className="text-sm text-ink">
                              {replaces ? (
                                <>
                                  This replaces the active rule{' '}
                                  <span className="font-semibold">“{replaces.value.summary}”</span>,
                                  which will be marked superseded.
                                </>
                              ) : isPersonalItem(item) ? (
                                'This preference will apply to your own reviews again.'
                              ) : (
                                'This rule will be included in AI context for every member of this workspace.'
                              )}
                            </p>
                            <div className="flex flex-wrap gap-2">
                              <button
                                type="button"
                                disabled={busyId === item.id}
                                onClick={() => {
                                  void onReactivate(item);
                                }}
                                className="rounded-xl bg-ink px-3 py-1.5 text-xs font-semibold text-inverse transition hover:opacity-90 disabled:opacity-50"
                              >
                                {busyId === item.id ? 'Reactivating…' : 'Confirm reactivate'}
                              </button>
                              <button
                                type="button"
                                disabled={busyId === item.id}
                                onClick={() => setConfirmReactivateId(null)}
                                className="rounded-xl border border-line bg-panel px-3 py-1.5 text-xs font-semibold text-ink transition hover:bg-mist disabled:opacity-50"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : null}
                      </div>
                      {canReactivate ? (
                        confirming ? null : (
                          <div className="flex shrink-0 flex-wrap gap-2">
                            <button
                              type="button"
                              disabled={busyId !== null}
                              onClick={() => setConfirmReactivateId(item.id)}
                              className="rounded-xl border border-line bg-panel px-3 py-1.5 text-xs font-semibold text-ink transition hover:bg-mist disabled:opacity-50"
                            >
                              Reactivate
                            </button>
                          </div>
                        )
                      ) : (
                        <p className="shrink-0 text-xs text-muted-foreground">
                          Managed by Owners and Admins
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </section>
      ) : null}

      {candidates.length > 0 ? (
        <section className="rise-in-delay-2 space-y-3">
          <h2 className="px-1 font-display text-lg font-semibold tracking-tight">Candidates</h2>
          <div className="overflow-hidden rounded-3xl border border-line bg-panel/75 shadow-panel">
            <ul className="divide-y divide-line/80">
              {candidates.map((candidate) => (
                <li
                  key={candidate.id}
                  className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start sm:justify-between"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold text-ink">{candidate.key}</p>
                      <span className="rounded-lg border border-line bg-mist px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                        {formatCategory(candidate.category)}
                      </span>
                      <span
                        className={[
                          'rounded-lg border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                          CONFIDENCE_STYLES[candidate.confidence],
                        ].join(' ')}
                      >
                        {candidate.confidence}
                      </span>
                    </div>
                    <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                      {candidate.proposedValue.summary}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground/90">{candidate.reason}</p>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    <button
                      type="button"
                      disabled={busyId === candidate.id || !canManage}
                      title={
                        canManage
                          ? undefined
                          : 'Only workspace Owners and Admins can save shared memory.'
                      }
                      onClick={() => {
                        void onRemember(candidate);
                      }}
                      className="rounded-xl bg-accent px-3 py-1.5 text-xs font-semibold text-accent-foreground transition hover:brightness-110 disabled:opacity-50"
                    >
                      Remember
                    </button>
                    <button
                      type="button"
                      disabled={busyId === candidate.id}
                      onClick={() => {
                        void onReject(candidate);
                      }}
                      className="rounded-xl border border-line bg-panel px-3 py-1.5 text-xs font-semibold text-ink transition hover:bg-mist disabled:opacity-50"
                    >
                      Not now
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}

      {loaded && loadedOwner && loadedRepo ? (
        <MemoryActivity
          workspaceId={currentWorkspaceId}
          workspaceRevision={workspaceRevision}
          owner={loadedOwner}
          repository={loadedRepo}
          ruleId={historyRule?.id ?? null}
          ruleLabel={historyRule?.key ?? null}
          onClearRule={() => setHistoryRule(null)}
          refreshKey={memoryVersion}
        />
      ) : null}

      <section className="rise-in-delay-2 space-y-3">
        <h2 className="px-1 font-display text-lg font-semibold tracking-tight">Add project rule</h2>
        <form
          onSubmit={onCreateRule}
          className="overflow-hidden rounded-3xl border border-line bg-panel/75 shadow-panel"
        >
          <div className="space-y-4 px-5 py-4">
            <StudioSelect
              id="rule-category"
              label="Category"
              value={ruleCategory}
              options={categoryOptions}
              onChange={setRuleCategory}
              className="sm:max-w-xs"
            />
            {!canManage ? (
              <p className="text-xs text-muted-foreground">
                Your role can save personal preferences, which apply only to your own reviews.
                Shared project rules are managed by workspace Owners and Admins. Saving needs GitHub
                access to this repository: your own GitHub token, or the workspace&apos;s Project X
                GitHub App.
              </p>
            ) : null}
            <div>
              <label htmlFor="rule-text" className="text-sm font-semibold text-ink">
                Rule
              </label>
              <textarea
                id="rule-text"
                rows={3}
                maxLength={400}
                placeholder="Prefer Vitest over Jest for unit tests."
                value={ruleText}
                onChange={(event) => setRuleText(event.target.value)}
                className="mt-2 w-full resize-y rounded-xl border border-line bg-mist px-3 py-2.5 text-sm text-ink outline-none ring-accent/30 focus:ring-2"
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3 border-t border-line/80 bg-mist/50 px-5 py-4">
            <button
              type="submit"
              disabled={creating || !canQuery || ruleText.trim().length === 0}
              className="rounded-xl bg-ink px-4 py-2.5 text-sm font-semibold text-inverse transition hover:opacity-90 disabled:opacity-50"
            >
              {creating ? 'Saving…' : canManage ? 'Save rule' : 'Save preference'}
            </button>
          </div>
        </form>
      </section>

      <section className="rise-in-delay-3 space-y-3">
        <h2 className="px-1 font-display text-lg font-semibold tracking-tight">
          Clear project memory
        </h2>
        <div className="rounded-3xl border border-line bg-panel/75 p-5 shadow-panel">
          <p className="text-sm text-muted-foreground">
            Archives all memory for this repository. Requires an explicit confirmation.
          </p>
          {!canManage ? (
            <p className="mt-3 text-xs text-muted-foreground">
              Only workspace Owners and Admins can clear shared project memory.
            </p>
          ) : !showClearDialog ? (
            <button
              type="button"
              disabled={!canQuery || !loaded}
              onClick={() => setShowClearDialog(true)}
              className="mt-4 rounded-xl border border-line bg-panel px-4 py-2.5 text-sm font-semibold text-ink transition hover:bg-mist disabled:opacity-50"
            >
              Clear memory…
            </button>
          ) : (
            <div className="mt-4 space-y-3 rounded-2xl border border-line bg-mist/60 p-4">
              <label className="flex items-start gap-3 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={clearConfirm}
                  onChange={(event) => setClearConfirm(event.target.checked)}
                  className="mt-1"
                />
                <span>
                  I understand this archives all project memory for{' '}
                  <span className="font-mono font-semibold">
                    {ownerTrimmed}/{repoTrimmed}
                  </span>
                  .
                </span>
              </label>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={!clearConfirm || clearing}
                  onClick={() => {
                    void onClear();
                  }}
                  className="rounded-xl bg-ink px-4 py-2.5 text-sm font-semibold text-inverse transition hover:opacity-90 disabled:opacity-50"
                >
                  {clearing ? 'Clearing…' : 'Confirm clear'}
                </button>
                <button
                  type="button"
                  disabled={clearing}
                  onClick={() => {
                    setShowClearDialog(false);
                    setClearConfirm(false);
                  }}
                  className="rounded-xl border border-line bg-panel px-4 py-2.5 text-sm font-semibold text-ink transition hover:bg-mist disabled:opacity-50"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </section>

      <p className="px-1 text-sm text-muted-foreground">
        Prefer managing tokens in{' '}
        <Link href="/app/settings" className="font-semibold text-accent hover:underline">
          Settings
        </Link>
        .
      </p>
    </div>
  );
}

export default function MemoryPage() {
  return (
    <Suspense
      fallback={
        <div className="rounded-3xl border border-line bg-panel/75 px-5 py-8 text-sm text-muted-foreground shadow-panel">
          Loading memory…
        </div>
      }
    >
      <MemoryPageContent />
    </Suspense>
  );
}
