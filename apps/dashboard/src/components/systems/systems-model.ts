import type {
  DiscoverRelationshipsResponse,
  MultiRepoRepositoryRole,
  RelatedRepositoryCandidate,
  RelatedRepositoryRelationship,
  RelationshipProvenanceType,
  RepositoryIdentity,
  MultiRepoScanIssueCode,
  MultiRepoScanReport,
  RepositoryRelationshipType,
  WorkspaceUsageCounter,
} from '@project-x/types';

import { usagePeriodKey } from '@project-x/shared';

import { ApiError, type RefreshSystemResponse } from '../../lib/api';

/** Pure view logic for /app/systems (no React, no fetching). */

export const ROLE_OPTIONS: { value: MultiRepoRepositoryRole; label: string }[] = [
  { value: 'frontend', label: 'Frontend' },
  { value: 'backend', label: 'Backend' },
  { value: 'gateway', label: 'Gateway' },
  { value: 'worker', label: 'Worker' },
  { value: 'shared-contract', label: 'Shared contract' },
  { value: 'library', label: 'Library' },
  { value: 'infrastructure', label: 'Infrastructure' },
  { value: 'unknown', label: 'Unassigned' },
];

export const RELATIONSHIP_TYPE_LABELS: Record<RepositoryRelationshipType, string> = {
  HTTP_CALLS: 'Calls HTTP API',
  PROVIDES_API: 'Provides API',
  CONSUMES_API: 'Consumes API',
  PRODUCES_EVENT: 'Produces events',
  CONSUMES_EVENT: 'Consumes events',
  DEPENDS_ON_PACKAGE: 'Depends on package',
  PROVIDES_PACKAGE: 'Provides package',
  SHARES_CONTRACT: 'Shares contract',
  DEPLOYMENT_DEPENDENCY: 'Deployment dependency',
  UNKNOWN: 'Related',
};

export const CANDIDATE_RELATIONSHIP_LABELS: Record<RelatedRepositoryRelationship, string> = {
  package_dependency: 'Package dependency',
  api_consumer: 'Consumes an API from this system',
  api_provider: 'Provides an API to this system',
  event_producer: 'Produces events this system uses',
  event_consumer: 'Consumes events from this system',
  shared_contract: 'Shares a contract',
  documentation_reference: 'Referenced in documentation',
  user_linked: 'Linked by a user',
  unknown: 'Possibly related',
};

export const PROVENANCE_LABELS: Record<RelationshipProvenanceType, string> = {
  user_explicit: 'Added by a user',
  package_reference: 'Package reference',
  source_import: 'Source import',
  openapi_reference: 'OpenAPI reference',
  http_call: 'HTTP call',
  kafka_producer: 'Event producer',
  kafka_consumer: 'Event consumer',
  documentation: 'Documentation',
  workflow_observation: 'Observed in a workflow',
  service_manifest: 'Declared in service-dependencies.json',
};

export function repoLabel(repo: Pick<RepositoryIdentity, 'owner' | 'repository'>): string {
  return `${repo.owner}/${repo.repository}`;
}

type OwnerRepo = Pick<RepositoryIdentity, 'owner' | 'repository'>;

export function sameRepo(a: OwnerRepo, b: OwnerRepo): boolean {
  return (
    a.owner.toLowerCase() === b.owner.toLowerCase() &&
    a.repository.toLowerCase() === b.repository.toLowerCase()
  );
}

export function candidateKey(candidate: RelatedRepositoryCandidate): string {
  return `${repoLabel(candidate.repository).toLowerCase()}:${candidate.relationship}`;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ── repository input ─────────────────────────────────────────────────────────

/** GitHub owner: 1–39 chars, alphanumeric or single hyphens, no leading/trailing hyphen. */
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
/** GitHub repository name: letters, digits, `.`, `_`, `-` (max 100). */
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

export type ParsedRepository =
  { ok: true; owner: string; repository: string } | { ok: false; error: string };

/**
 * Accepts `owner/repo`, `github.com/owner/repo` or a full GitHub URL (extra path, `.git`,
 * query and hash are ignored). Purely local parsing — access is verified by the API.
 */
export function parseRepositoryInput(raw: string): ParsedRepository {
  let value = raw.trim();
  if (!value) return { ok: false, error: 'Enter a repository as owner/repository.' };
  value = value.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  if (/^github\.com\//i.test(value)) value = value.slice('github.com/'.length);
  else if (value.includes('.') && value.split('/')[0]!.includes('.')) {
    return { ok: false, error: 'Only GitHub repositories are supported.' };
  }
  value = value.split(/[?#]/)[0]!;
  const [owner = '', rawRepo = ''] = value.split('/');
  const repository = rawRepo.replace(/\.git$/i, '');
  if (!owner || !repository) {
    return { ok: false, error: 'Use the format owner/repository, e.g. acme/payments-api.' };
  }
  if (!OWNER_RE.test(owner)) return { ok: false, error: `“${owner}” is not a valid GitHub owner.` };
  if (!REPO_RE.test(repository) || repository === '.' || repository === '..') {
    return { ok: false, error: `“${repository}” is not a valid repository name.` };
  }
  return { ok: true, owner, repository };
}

// ── analysis results ─────────────────────────────────────────────────────────

export type ResultTone = 'success' | 'warning';

export interface AnalysisSummary {
  tone: ResultTone;
  title: string;
  lines: string[];
  /** Suggest adding a repository (system has only one) — never promises discoveries. */
  suggestAddRepository: boolean;
  unavailable: RepositoryIdentity[];
  truncated: boolean;
  /** Repositories read only partly, invalid manifests, unmatched calls (from `scan`). */
  notes: string[];
}

const ISSUE_TEXT: Record<MultiRepoScanIssueCode, string> = {
  repository_inaccessible: 'no access',
  token_invalid: 'GitHub rejected the token',
  rate_limited: 'GitHub rate limit reached',
  github_error: 'GitHub error',
  tree_truncated: 'too many files to list completely',
  file_budget_reached: 'file limit reached',
  byte_budget_reached: 'size limit reached',
  request_budget_reached: 'request limit reached',
  file_too_large: 'some files too large to read',
  file_unreadable: 'some files could not be read',
  manifest_invalid: 'service-dependencies.json is not valid',
};

/** Plain-language notes from the scan report; empty when everything was read. */
export function scanNotes(scan: MultiRepoScanReport | undefined): string[] {
  if (!scan) return [];
  const notes: string[] = [];
  for (const repo of scan.repositories) {
    if (repo.status !== 'partial' || repo.issues.length === 0) continue;
    notes.push(
      `${repoLabel(repo.repository)} was only partly read: ${repo.issues.map((i) => ISSUE_TEXT[i.code] ?? i.code).join(', ')}.`,
    );
  }
  const unresolved = scan.repositories.reduce((n, r) => n + r.unresolvedHttpCalls, 0);
  if (unresolved > 0) {
    notes.push(
      `${plural(unresolved, 'HTTP call')} could not be matched to exactly one repository in this system, so no relationship was recorded for ${unresolved === 1 ? 'it' : 'them'}.`,
    );
  }
  return notes;
}

export function summarizeRefresh(
  result: RefreshSystemResponse,
  repositoryCount: number,
): AnalysisSummary {
  const warning =
    result.unavailable.length > 0 || result.truncated || Boolean(result.scan?.partial);
  // `relationshipsChecked` is the number of relationships known for the system after the scan.
  const lines = [`${plural(result.analyzed, 'repository', 'repositories')} analyzed.`];
  if (result.relationshipsChecked === 0 && result.candidates.length === 0) {
    lines.push('No relationships found.');
  } else {
    lines.push(
      result.relationshipsChecked > 0
        ? `${plural(result.relationshipsChecked, 'relationship')} found.`
        : 'No relationships found between these repositories.',
    );
    lines.push(
      result.candidates.length > 0
        ? `${plural(result.candidates.length, 'related repository', 'related repositories')} suggested for review.`
        : 'No new related repositories suggested.',
    );
  }
  return {
    tone: warning ? 'warning' : 'success',
    title: warning ? 'Analysis completed with warnings' : 'Analysis completed',
    lines,
    suggestAddRepository: repositoryCount <= 1,
    unavailable: result.unavailable,
    truncated: result.truncated,
    notes: scanNotes(result.scan),
  };
}

export function summarizeDiscovery(
  result: DiscoverRelationshipsResponse,
  repositoryCount: number,
): AnalysisSummary {
  const active = result.relationships.filter((r) => r.status === 'active').length;
  const lines = [
    active === 0
      ? 'No relationships found between the repositories in this system.'
      : `${plural(active, 'relationship')} known in this system.`,
    result.candidates.length === 0
      ? 'No related repositories suggested.'
      : `${plural(result.candidates.length, 'related repository', 'related repositories')} suggested for review.`,
  ];
  const partial = result.truncated || Boolean(result.scan?.partial);
  return {
    tone: partial ? 'warning' : 'success',
    title: partial ? 'Discovery completed with partial results' : 'Discovery completed',
    lines,
    suggestAddRepository: repositoryCount <= 1,
    unavailable:
      result.scan?.repositories
        .filter((r) => r.status === 'unavailable')
        .map((r) => r.repository) ?? [],
    truncated: result.truncated,
    notes: scanNotes(result.scan),
  };
}

// ── errors ───────────────────────────────────────────────────────────────────

export interface ErrorGuidance {
  title: string;
  message: string;
  action?: { label: string; href: string };
  /** Safe to offer "Try again" (transient). */
  retryable: boolean;
}

export function describeError(err: unknown, fallbackTitle: string): ErrorGuidance {
  const code = err instanceof ApiError ? err.code : undefined;
  const apiMessage = err instanceof ApiError ? err.message : undefined;
  switch (code) {
    case 'FEATURE_NOT_AVAILABLE':
      return {
        title: 'Systems are not included in your plan',
        message: 'Upgrade the workspace plan to group repositories and analyze them together.',
        action: { label: 'View plans', href: '/app/billing' },
        retryable: false,
      };
    case 'USAGE_LIMIT_REACHED':
      return {
        title: 'Analysis limit reached',
        message: apiMessage ?? 'This workspace has used all analyses included in its plan for now.',
        action: { label: 'Plan & usage', href: '/app/billing' },
        retryable: false,
      };
    case 'SYSTEM_REPOSITORY_LIMIT_REACHED':
      return {
        title: 'Plan limit reached',
        message: apiMessage ?? 'Your plan does not allow more systems or repositories.',
        action: { label: 'Plan & usage', href: '/app/billing' },
        retryable: false,
      };
    case 'SYSTEM_REPOSITORY_NOT_ACCESSIBLE':
      return {
        title: 'Repository not accessible',
        message:
          apiMessage ??
          'Project X could not confirm access to this repository with your GitHub connection.',
        action: { label: 'GitHub settings', href: '/app/settings' },
        retryable: false,
      };
    case 'AI_OPERATION_IN_PROGRESS':
      return {
        title: 'An analysis is already running',
        message: 'This system is already being analyzed. Wait for it to finish, then try again.',
        retryable: false,
      };
    case 'SYSTEM_CONTEXT_STALE':
      return {
        title: 'GitHub could not be reached',
        message: apiMessage ?? 'Try again in a moment.',
        retryable: true,
      };
    default:
      return {
        title: fallbackTitle,
        message: apiMessage ?? 'Something went wrong. Please try again.',
        retryable: !(err instanceof ApiError) || err.statusCode >= 500,
      };
  }
}

/** Most recent validation time across relationships (real data only). */
export function lastValidatedAt(
  relationships: { lastValidatedAt?: string; freshness?: { lastValidatedAt: string } }[],
): string | null {
  let latest: number | null = null;
  for (const rel of relationships) {
    const raw = rel.freshness?.lastValidatedAt ?? rel.lastValidatedAt;
    const ms = raw ? Date.parse(raw) : NaN;
    if (!Number.isNaN(ms) && (latest === null || ms > latest)) latest = ms;
  }
  return latest === null ? null : new Date(latest).toISOString();
}

// ── usage ────────────────────────────────────────────────────────────────────

export interface AnalysisUsage {
  used: number;
  limit: number;
  remaining: number;
}

/**
 * Monthly `multi_repo_analysis` usage from the workspace bootstrap. Null when the plan is
 * unlimited, the data is missing, or it belongs to a previous month (stale tab) — the UI then
 * shows nothing rather than a wrong number. The server remains the authority.
 */
export function analysisUsage(
  usage: WorkspaceUsageCounter[] | undefined,
  now: Date = new Date(),
): AnalysisUsage | null {
  const counter = usage?.find((u) => u.metric === 'multi_repo_analysis');
  if (!counter || counter.limit === null || counter.remaining === null) return null;
  if (counter.period !== usagePeriodKey(now)) return null;
  return { used: counter.count, limit: counter.limit, remaining: counter.remaining };
}
