import type { RepositoryIdentity, RepositoryRelationship } from '@project-x/types';

import { repositoryKey } from './identity';

type VersionRepo = {
  repository: RepositoryIdentity;
  enabled?: boolean;
  role?: string;
  headSha?: string;
  memoryVersion?: string;
};

type VersionRelationship = Pick<
  RepositoryRelationship,
  'id' | 'type' | 'status' | 'from' | 'to' | 'resource'
>;

/** Simple stable string hash (djb2) — matches project-memory versioning style. */
function djb2(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Deterministic system context version/fingerprint.
 * Changes when membership, roles, heads, or active relationships change.
 */
export function computeSystemContextVersion(input: {
  systemId: string;
  repositories: VersionRepo[];
  relationships?: VersionRelationship[];
}): string {
  const repos = input.repositories
    .map((repo) => {
      const enabled = repo.enabled === false ? '0' : '1';
      return [
        repositoryKey(repo.repository),
        enabled,
        repo.role ?? '',
        repo.headSha ?? '',
        repo.memoryVersion ?? '',
      ].join('|');
    })
    .sort();

  const relationships = (input.relationships ?? [])
    .filter((rel) => rel.status === 'active')
    .map((rel) =>
      [
        rel.id,
        rel.type,
        repositoryKey(rel.from),
        repositoryKey(rel.to),
        rel.resource?.kind ?? '',
        rel.resource?.key ?? '',
      ].join('|'),
    )
    .sort();

  const payload = [
    `system:${input.systemId}`,
    `repos:${repos.join('\n')}`,
    `rels:${relationships.join('\n')}`,
  ].join('\n');

  return `scv-${repos.length}-${relationships.length}-${djb2(payload)}`;
}
