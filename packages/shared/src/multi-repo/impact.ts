import type {
  MultiRepoAnalysisScope,
  MultiRepoChangeImpactAnalysis,
  MultiRepoImpactItem,
  RepositoryIdentity,
} from '@project-x/types';

import { sameRepository } from './identity';
import { validateRepositoriesInScope } from './validate';

export function emptyAnalysisScope(
  systemId: string,
  repositories: RepositoryIdentity[] = [],
): MultiRepoAnalysisScope {
  return {
    systemId,
    repositoriesAnalyzed: repositories,
    filesAnalyzed: 0,
    truncated: false,
  };
}

/** Build a typed change-impact skeleton — callers fill evidence later. */
export function buildChangeImpactSkeleton(input: {
  systemId: string;
  primaryRepository: RepositoryIdentity;
  summary: string;
  pullRequestNumber?: number;
  headSha?: string;
  repositoriesAnalyzed?: RepositoryIdentity[];
}): MultiRepoChangeImpactAnalysis {
  return {
    primaryChange: {
      repository: input.primaryRepository,
      pullRequestNumber: input.pullRequestNumber,
      headSha: input.headSha,
      summary: input.summary,
    },
    impactedRepositories: [],
    contractImpacts: [],
    risks: [],
    requiredCoordination: [],
    unaffectedOrNotEvident: [],
    scope: emptyAnalysisScope(
      input.systemId,
      input.repositoriesAnalyzed ?? [input.primaryRepository],
    ),
  };
}

/**
 * Drop impact items whose repositories are outside the allowed analysis scope.
 * Never invents repositories — rejects unknown identities.
 */
export function validateImpactRepositoriesInScope(
  items: MultiRepoImpactItem[],
  allowed: RepositoryIdentity[],
): {
  accepted: MultiRepoImpactItem[];
  rejected: MultiRepoImpactItem[];
} {
  const accepted: MultiRepoImpactItem[] = [];
  const rejected: MultiRepoImpactItem[] = [];

  for (const item of items) {
    const inScope = allowed.some((repo) => sameRepository(repo, item.repository));
    if (inScope) {
      accepted.push(item);
    } else {
      rejected.push(item);
    }
  }

  return { accepted, rejected };
}

export function filterImpactAnalysisToScope(
  analysis: MultiRepoChangeImpactAnalysis,
  allowed: RepositoryIdentity[],
): MultiRepoChangeImpactAnalysis {
  const validation = validateRepositoriesInScope(
    [analysis.primaryChange.repository, ...analysis.impactedRepositories.map((i) => i.repository)],
    allowed,
  );

  // Primary change may be out of enabled set in edge cases — keep but mark scope carefully.
  const { accepted } = validateImpactRepositoriesInScope(analysis.impactedRepositories, allowed);

  return {
    ...analysis,
    impactedRepositories: accepted,
    requiredCoordination: analysis.requiredCoordination.filter((item) =>
      allowed.some((repo) => sameRepository(repo, item.repository)),
    ),
    unaffectedOrNotEvident: (analysis.unaffectedOrNotEvident ?? []).filter((item) =>
      allowed.some((repo) => sameRepository(repo, item.repository)),
    ),
    scope: {
      ...analysis.scope,
      repositoriesAnalyzed: validation.inScope,
      truncated: analysis.scope.truncated || validation.outOfScope.length > 0,
    },
  };
}
