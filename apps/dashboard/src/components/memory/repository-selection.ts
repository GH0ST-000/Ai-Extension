import { parseOwnerRepo, repositoryKey, type OwnerRepo } from '@project-x/shared';
import type { PrReviewHistoryItem, ProjectSystem } from '@project-x/types';

/**
 * Repository choices for the Memory page. Suggestions are convenience only: they are never an
 * authorization source — the API re-checks workspace membership and GitHub access on every
 * Memory request. Browser storage holds repository names only (no tokens, no content).
 */

export type RepositoryOption = OwnerRepo & { fullName: string };
export type RepositoryGroup = { id: string; label: string; options: RepositoryOption[] };

/** GitHub user/organization names: letters, digits, single hyphens; at most 39 characters. */
const GITHUB_OWNER = /^[a-z0-9](?:[a-z0-9-]{0,38})$/i;

/**
 * `owner/repository` or a github.com repository URL → canonical (lowercase) identity.
 * Anything else (other hosts, extra path segments, malformed names) → null.
 */
export function parseRepositoryInput(input: string): RepositoryOption | null {
  if (typeof input !== 'string' || input.length > 300) return null;
  const parsed = parseOwnerRepo(input);
  if (!parsed || !GITHUB_OWNER.test(parsed.owner) || parsed.repository.length > 100) return null;
  if (parsed.repository === '.' || parsed.repository === '..') return null;
  return { ...parsed, fullName: `${parsed.owner}/${parsed.repository}` };
}

export const sameRepositoryOption = (a: OwnerRepo, b: OwnerRepo) =>
  repositoryKey(a) === repositoryKey(b);

// ── per-workspace recent / last selection (versioned browser storage) ────────────────────

export const REPOSITORY_STORAGE_KEY = 'px.memory.repositories.v1';
export const MAX_RECENT_REPOSITORIES = 10;
const MAX_WORKSPACES = 20;

type StoredWorkspace = { last: string | null; recent: string[] };
type Stored = { v: 1; workspaces: Record<string, StoredWorkspace> };

function readStore(): Stored {
  try {
    const raw = window.localStorage.getItem(REPOSITORY_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (
      parsed &&
      typeof parsed === 'object' &&
      (parsed as Stored).v === 1 &&
      typeof (parsed as Stored).workspaces === 'object' &&
      (parsed as Stored).workspaces !== null
    ) {
      return parsed as Stored;
    }
  } catch {
    // Unavailable or corrupted storage: start over.
  }
  return { v: 1, workspaces: {} };
}

function writeStore(store: Stored): void {
  try {
    const ids = Object.keys(store.workspaces);
    for (const id of ids.slice(0, Math.max(0, ids.length - MAX_WORKSPACES))) {
      delete store.workspaces[id];
    }
    window.localStorage.setItem(REPOSITORY_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // Storage full or disabled: selection still works for this page view.
  }
}

/** Valid, de-duplicated entries only; anything malformed or outdated is dropped. */
function readWorkspace(workspaceId: string): {
  last: RepositoryOption | null;
  recent: RepositoryOption[];
} {
  const entry = readStore().workspaces[workspaceId];
  const recent: RepositoryOption[] = [];
  if (entry && Array.isArray(entry.recent)) {
    for (const value of entry.recent) {
      const option = typeof value === 'string' ? parseRepositoryInput(value) : null;
      if (option && !recent.some((r) => sameRepositoryOption(r, option))) recent.push(option);
      if (recent.length >= MAX_RECENT_REPOSITORIES) break;
    }
  }
  const last = entry && typeof entry.last === 'string' ? parseRepositoryInput(entry.last) : null;
  return { last, recent };
}

export function readRecentRepositories(workspaceId: string): RepositoryOption[] {
  return readWorkspace(workspaceId).recent;
}

export function readLastRepository(workspaceId: string): RepositoryOption | null {
  return readWorkspace(workspaceId).last;
}

/** After a successful load: most recent first, de-duplicated, at most 10; also the last selection. */
export function rememberRepository(workspaceId: string, repository: OwnerRepo): void {
  const option = parseRepositoryInput(`${repository.owner}/${repository.repository}`);
  if (!option) return;
  const store = readStore();
  const { recent } = readWorkspace(workspaceId);
  const next = [option, ...recent.filter((r) => !sameRepositoryOption(r, option))].slice(
    0,
    MAX_RECENT_REPOSITORIES,
  );
  delete store.workspaces[workspaceId]; // re-insert: most recently used workspace last
  store.workspaces[workspaceId] = { last: option.fullName, recent: next.map((r) => r.fullName) };
  writeStore(store);
}

/** A repository the API refused (no access / not found): never restore or suggest it again. */
export function forgetRepository(workspaceId: string, repository: OwnerRepo): void {
  const store = readStore();
  if (!store.workspaces[workspaceId]) return;
  const { last, recent } = readWorkspace(workspaceId);
  store.workspaces[workspaceId] = {
    last: last && !sameRepositoryOption(last, repository) ? last.fullName : null,
    recent: recent.filter((r) => !sameRepositoryOption(r, repository)).map((r) => r.fullName),
  };
  writeStore(store);
}

/** The user cleared the selection: do not restore it next time (recents stay). */
export function clearLastRepository(workspaceId: string): void {
  const store = readStore();
  const entry = store.workspaces[workspaceId];
  if (!entry) return;
  store.workspaces[workspaceId] = { ...entry, last: null };
  writeStore(store);
}

// ── suggestions ──────────────────────────────────────────────────────────────────────────

/** Recently used, then each System, then Review History; each repository listed once. */
export function buildRepositoryGroups(input: {
  recent: RepositoryOption[];
  systems?: ProjectSystem[];
  history?: Pick<PrReviewHistoryItem, 'owner' | 'repository'>[];
}): RepositoryGroup[] {
  const seen = new Set<string>();
  const take = (candidates: OwnerRepo[]): RepositoryOption[] => {
    const out: RepositoryOption[] = [];
    for (const c of candidates) {
      const option = parseRepositoryInput(`${c.owner}/${c.repository}`);
      if (!option) continue;
      const key = repositoryKey(option);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(option);
    }
    return out;
  };
  const groups: RepositoryGroup[] = [];
  const recent = take(input.recent);
  if (recent.length) groups.push({ id: 'recent', label: 'Recently used', options: recent });
  for (const system of input.systems ?? []) {
    const options = take(system.repositories.map((r) => r.repository));
    if (options.length) {
      groups.push({ id: `system:${system.id}`, label: `System · ${system.name}`, options });
    }
  }
  const history = take(input.history ?? []);
  if (history.length)
    groups.push({ id: 'history', label: 'From Review History', options: history });
  return groups;
}

/** Case-insensitive match on owner, repository or `owner/repository` (and group names). */
export function filterRepositoryGroups(
  groups: RepositoryGroup[],
  query: string,
): RepositoryGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return groups;
  return groups
    .map((group) =>
      group.label.toLowerCase().includes(q)
        ? group
        : { ...group, options: group.options.filter((o) => o.fullName.includes(q)) },
    )
    .filter((group) => group.options.length > 0);
}
