import type { RepositoryIdentity } from '@project-x/types';

export type OwnerRepo = {
  owner: string;
  repository: string;
};

/** Normalize GitHub owner/repo display identifiers (lowercase, trimmed). */
export function normalizeOwnerRepo(owner: string, repository: string): OwnerRepo {
  return {
    owner: owner.trim().toLowerCase(),
    repository: repository.trim().toLowerCase(),
  };
}

/**
 * Parse "owner/repo" (optionally with github.com URL prefix).
 * Returns null when the shape is not a simple owner/repo pair.
 */
export function parseOwnerRepo(input: string): OwnerRepo | null {
  const raw = input.trim();
  if (!raw) return null;

  let path = raw;
  const urlMatch = raw.match(
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/#?\s]+)\/([^/#?\s]+?)(?:\.git)?\/?$/i,
  );
  if (urlMatch) {
    path = `${urlMatch[1]}/${urlMatch[2]}`;
  }

  const cleaned = path.replace(/^\/+|\/+$/g, '');
  const parts = cleaned.split('/').filter(Boolean);
  if (parts.length !== 2) return null;

  const owner = parts[0]?.trim() ?? '';
  const repository = parts[1]?.trim().replace(/\.git$/i, '') ?? '';
  if (!owner || !repository) return null;
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repository)) {
    return null;
  }

  return normalizeOwnerRepo(owner, repository);
}

export function repositoryKey(
  identity: Pick<RepositoryIdentity, 'provider' | 'owner' | 'repository'> | OwnerRepo,
): string {
  const provider = 'provider' in identity && identity.provider ? identity.provider : 'github';
  const { owner, repository } = normalizeOwnerRepo(identity.owner, identity.repository);
  return `${provider}:${owner}/${repository}`;
}

export function sameRepository(
  a: Pick<RepositoryIdentity, 'provider' | 'owner' | 'repository' | 'repositoryId'> | OwnerRepo,
  b: Pick<RepositoryIdentity, 'provider' | 'owner' | 'repository' | 'repositoryId'> | OwnerRepo,
): boolean {
  const aId = 'repositoryId' in a ? a.repositoryId : undefined;
  const bId = 'repositoryId' in b ? b.repositoryId : undefined;
  if (aId && bId && aId === bId) {
    return true;
  }
  return repositoryKey(a) === repositoryKey(b);
}

export function toRepositoryIdentity(
  owner: string,
  repository: string,
  repositoryId?: string,
): RepositoryIdentity {
  const normalized = normalizeOwnerRepo(owner, repository);
  return repositoryId
    ? { provider: 'github', ...normalized, repositoryId }
    : { provider: 'github', ...normalized };
}
