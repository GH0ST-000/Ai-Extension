import type { MultiRepoErrorCode, RepositoryIdentity } from '@project-x/types';
import { MULTI_REPO_MAX_REPOS_PER_ANALYSIS } from '@project-x/types';

import { normalizeOwnerRepo, sameRepository, toRepositoryIdentity } from './identity';

export type MultiRepoValidateResult<T> =
  { ok: true; value: T } | { ok: false; code: MultiRepoErrorCode; message: string };

export function validateRepositoriesInScope(
  candidates: RepositoryIdentity[],
  allowed: RepositoryIdentity[],
): {
  inScope: RepositoryIdentity[];
  outOfScope: RepositoryIdentity[];
} {
  const inScope: RepositoryIdentity[] = [];
  const outOfScope: RepositoryIdentity[] = [];

  for (const candidate of candidates) {
    if (allowed.some((repo) => sameRepository(repo, candidate))) {
      inScope.push(candidate);
    } else {
      outOfScope.push(candidate);
    }
  }

  return { inScope, outOfScope };
}

/**
 * Reject invented repositories — every identity must appear in the allowed scope.
 * Also enforces per-analysis repository budget.
 */
export function validateAnalysisRepositorySelection(
  selected: Array<RepositoryIdentity | { owner: string; repository: string }>,
  allowed: RepositoryIdentity[],
  maxRepos: number = MULTI_REPO_MAX_REPOS_PER_ANALYSIS,
): MultiRepoValidateResult<RepositoryIdentity[]> {
  if (selected.length === 0) {
    return {
      ok: false,
      code: 'SYSTEM_CONTEXT_NOT_CONFIGURED',
      message: 'At least one repository must be selected for analysis.',
    };
  }

  if (selected.length > maxRepos) {
    return {
      ok: false,
      code: 'SYSTEM_REPOSITORY_LIMIT_REACHED',
      message: `Multi-repo analysis is limited to ${maxRepos} repositories at a time.`,
    };
  }

  const resolved: RepositoryIdentity[] = [];
  for (const item of selected) {
    const identity =
      'provider' in item
        ? {
            ...item,
            ...normalizeOwnerRepo(item.owner, item.repository),
            provider: 'github' as const,
          }
        : toRepositoryIdentity(item.owner, item.repository);

    const match = allowed.find((repo) => sameRepository(repo, identity));
    if (!match) {
      return {
        ok: false,
        code: 'SYSTEM_REPOSITORY_NOT_ACCESSIBLE',
        message: `Repository ${identity.owner}/${identity.repository} is not in the selected system scope.`,
      };
    }
    if (!resolved.some((repo) => sameRepository(repo, match))) {
      resolved.push(match);
    }
  }

  return { ok: true, value: resolved };
}

export function assertNoInventedRepositories(
  claimed: RepositoryIdentity[],
  allowed: RepositoryIdentity[],
): MultiRepoValidateResult<true> {
  const { outOfScope } = validateRepositoriesInScope(claimed, allowed);
  if (outOfScope.length > 0) {
    const labels = outOfScope.map((r) => `${r.owner}/${r.repository}`).join(', ');
    return {
      ok: false,
      code: 'RELATED_REPOSITORY_AMBIGUOUS',
      message: `Rejected repositories outside selected scope: ${labels}`,
    };
  }
  return { ok: true, value: true };
}
