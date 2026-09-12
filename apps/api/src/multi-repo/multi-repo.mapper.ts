import type {
  ProjectSystem as ProjectSystemRow,
  ProjectSystemRepository as ProjectSystemRepositoryRow,
  RepositoryRelationship as RepositoryRelationshipRow,
} from '@prisma/client';
import type {
  MultiRepoRepositoryRole,
  MultiRepoRepositorySource,
  ProjectSystem,
  ProjectSystemRepositoryRef,
  RelationshipConfidence,
  RelationshipFreshness,
  RelationshipProvenance,
  RelationshipResourceKind,
  RelationshipStatus,
  RepositoryIdentity,
  RepositoryRelationship,
  RepositoryRelationshipType,
} from '@project-x/types';

type SystemWithRepos = ProjectSystemRow & {
  repositories: ProjectSystemRepositoryRow[];
};

export function toRepositoryIdentity(owner: string, repository: string): RepositoryIdentity {
  return { provider: 'github', owner, repository };
}

export function toProjectSystemRepositoryRef(
  row: ProjectSystemRepositoryRow,
): ProjectSystemRepositoryRef {
  return {
    id: row.id,
    repository: toRepositoryIdentity(row.owner, row.repository),
    role: row.role as MultiRepoRepositoryRole,
    enabled: row.enabled,
    source: row.source as MultiRepoRepositorySource,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toProjectSystem(row: SystemWithRepos): ProjectSystem {
  return {
    id: row.id,
    name: row.name,
    primaryRepository: toRepositoryIdentity(row.primaryOwner, row.primaryRepository),
    repositories: row.repositories.map(toProjectSystemRepositoryRef),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toRepositoryRelationship(row: RepositoryRelationshipRow): RepositoryRelationship {
  const provenance = row.provenanceJson as unknown as RelationshipProvenance[];
  const freshness =
    row.freshnessJson == null ? undefined : (row.freshnessJson as unknown as RelationshipFreshness);

  return {
    id: row.id,
    from: toRepositoryIdentity(row.fromOwner, row.fromRepository),
    to: toRepositoryIdentity(row.toOwner, row.toRepository),
    type: row.type as RepositoryRelationshipType,
    ...(row.resourceKind && row.resourceKey
      ? {
          resource: {
            kind: row.resourceKind as RelationshipResourceKind,
            key: row.resourceKey,
          },
        }
      : {}),
    confidence: row.confidence as RelationshipConfidence,
    provenance: Array.isArray(provenance) ? provenance : [],
    status: row.status as RelationshipStatus,
    ...(freshness ? { freshness } : {}),
    ...(row.lastValidatedAt ? { lastValidatedAt: row.lastValidatedAt.toISOString() } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
