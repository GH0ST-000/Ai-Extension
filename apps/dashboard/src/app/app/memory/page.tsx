'use client';

import { type FormEvent, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import type {
  ProjectMemoryCandidate,
  ProjectMemoryCategory,
  ProjectMemoryConfidence,
  ProjectMemoryItem,
  ProjectProfile,
} from '@project-x/types';
import {
  PROJECT_MEMORY_CATEGORY_VALUES,
  ProjectMemoryCategory as Categories,
} from '@project-x/types';

import {
  ApiError,
  clearProjectMemory,
  confirmMemoryCandidate,
  createProjectMemoryRule,
  getProjectMemoryProfile,
  learnProjectMemory,
  listProjectMemory,
  rejectMemoryCandidate,
  updateProjectMemory,
} from '../../../lib/api';
import { StudioSelect } from '../../../components/studio-select';

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

function apiMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
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
  const [owner, setOwner] = useState(() => searchParams.get('owner')?.trim() ?? '');
  const [repo, setRepo] = useState(() => searchParams.get('repo')?.trim() ?? '');
  const [items, setItems] = useState<ProjectMemoryItem[]>([]);
  const [profile, setProfile] = useState<ProjectProfile | null>(null);
  const [candidates, setCandidates] = useState<ProjectMemoryCandidate[]>([]);
  const [memoryVersion, setMemoryVersion] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [learning, setLearning] = useState(false);
  const [creating, setCreating] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [ruleText, setRuleText] = useState('');
  const [ruleCategory, setRuleCategory] = useState<ProjectMemoryCategory>(
    Categories.USER_PREFERENCE,
  );
  const [clearConfirm, setClearConfirm] = useState(false);
  const [showClearDialog, setShowClearDialog] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ownerTrimmed = owner.trim();
  const repoTrimmed = repo.trim();
  const canQuery = ownerTrimmed.length > 0 && repoTrimmed.length > 0;

  const activeItems = useMemo(() => items.filter((item) => item.status === 'active'), [items]);
  const grouped = useMemo(() => groupByCategory(activeItems), [activeItems]);
  const chips = useMemo(() => profileChipCounts(profile), [profile]);

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
        const [list, nextProfile] = await Promise.all([
          listProjectMemory(qOwner, qRepo),
          getProjectMemoryProfile(qOwner, qRepo),
        ]);
        if (cancelled) {
          return;
        }
        setItems(list.items);
        setMemoryVersion(list.memoryVersion);
        setProfile(nextProfile);
        setLoaded(true);
      } catch (err) {
        if (!cancelled) {
          setLoaded(true);
          setItems([]);
          setProfile(null);
          setMemoryVersion(null);
          setError(apiMessage(err, 'Unable to load project memory.'));
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
  }, [searchParams]);

  const refresh = useCallback(async () => {
    if (!canQuery) {
      return;
    }
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      const [list, nextProfile] = await Promise.all([
        listProjectMemory(ownerTrimmed, repoTrimmed),
        getProjectMemoryProfile(ownerTrimmed, repoTrimmed),
      ]);
      setItems(list.items);
      setMemoryVersion(list.memoryVersion);
      setProfile(nextProfile);
      setLoaded(true);
    } catch (err) {
      setLoaded(true);
      setItems([]);
      setProfile(null);
      setMemoryVersion(null);
      setError(apiMessage(err, 'Unable to load project memory.'));
    } finally {
      setLoading(false);
    }
  }, [canQuery, ownerTrimmed, repoTrimmed]);

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
    setMessage(null);
    try {
      const result = await learnProjectMemory(ownerTrimmed, repoTrimmed);
      setCandidates(result.candidates);
      if (result.profile) {
        setProfile(result.profile);
      }
      setMemoryVersion(result.memoryVersion);
      setMessage(
        result.accepted.length > 0
          ? `Learned ${result.accepted.length} item${result.accepted.length === 1 ? '' : 's'}.`
          : 'Learn finished. Review candidates below.',
      );
      await refresh();
    } catch (err) {
      setError(apiMessage(err, 'Unable to learn project context.'));
    } finally {
      setLearning(false);
    }
  }

  async function onCreateRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canQuery || ruleText.trim().length === 0) {
      return;
    }
    setCreating(true);
    setError(null);
    setMessage(null);
    try {
      await createProjectMemoryRule(ownerTrimmed, repoTrimmed, {
        category: ruleCategory,
        text: ruleText.trim(),
      });
      setRuleText('');
      setMessage('Project rule saved.');
      await refresh();
    } catch (err) {
      setError(apiMessage(err, 'Unable to create project rule.'));
    } finally {
      setCreating(false);
    }
  }

  async function onStatus(item: ProjectMemoryItem, status: 'archived' | 'disputed') {
    if (!canQuery) {
      return;
    }
    setBusyId(item.id);
    setError(null);
    setMessage(null);
    try {
      await updateProjectMemory(ownerTrimmed, repoTrimmed, item.id, { status });
      setMessage(status === 'archived' ? 'Memory archived.' : 'Memory marked disputed.');
      await refresh();
    } catch (err) {
      setError(apiMessage(err, 'Unable to update memory.'));
    } finally {
      setBusyId(null);
    }
  }

  async function onClear() {
    if (!canQuery || !clearConfirm) {
      return;
    }
    setClearing(true);
    setError(null);
    setMessage(null);
    try {
      const result = await clearProjectMemory(ownerTrimmed, repoTrimmed);
      setCandidates([]);
      setClearConfirm(false);
      setShowClearDialog(false);
      setMessage(`Cleared ${result.archived} memor${result.archived === 1 ? 'y' : 'ies'}.`);
      await refresh();
    } catch (err) {
      setError(apiMessage(err, 'Unable to clear project memory.'));
    } finally {
      setClearing(false);
    }
  }

  async function onRemember(candidate: ProjectMemoryCandidate) {
    if (!canQuery) {
      return;
    }
    setBusyId(candidate.id);
    setError(null);
    try {
      await confirmMemoryCandidate(ownerTrimmed, repoTrimmed, candidate.id);
      setCandidates((prev) => prev.filter((c) => c.id !== candidate.id));
      setMessage('Candidate remembered.');
      await refresh();
    } catch (err) {
      setError(apiMessage(err, 'Unable to confirm candidate.'));
    } finally {
      setBusyId(null);
    }
  }

  async function onReject(candidate: ProjectMemoryCandidate) {
    if (!canQuery) {
      return;
    }
    setBusyId(candidate.id);
    setError(null);
    try {
      await rejectMemoryCandidate(ownerTrimmed, repoTrimmed, candidate.id);
      setCandidates((prev) => prev.filter((c) => c.id !== candidate.id));
      setMessage('Candidate dismissed.');
    } catch (err) {
      setError(apiMessage(err, 'Unable to reject candidate.'));
    } finally {
      setBusyId(null);
    }
  }

  const categoryOptions = useMemo(
    () =>
      PROJECT_MEMORY_CATEGORY_VALUES.map((category) => ({
        value: category,
        label: formatCategory(category),
      })),
    [],
  );

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
              disabled={learning || !canQuery}
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

      {(message || error) && (
        <div className="rise-in-delay-1 space-y-1 px-1">
          {message ? <p className="text-sm text-accent">{message}</p> : null}
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
          <div className="rounded-3xl border border-line bg-panel/75 px-5 py-8 text-sm text-muted-foreground shadow-panel">
            Project X has not learned this repository yet.
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
                      </div>
                      <div className="flex shrink-0 flex-wrap gap-2">
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
                      disabled={busyId === candidate.id}
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
              {creating ? 'Saving…' : 'Save rule'}
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
          {!showClearDialog ? (
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
