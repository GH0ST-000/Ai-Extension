import type { ProjectMemory as ProjectMemoryRow } from '@prisma/client';
import type {
  ProjectMemoryFreshness,
  ProjectMemoryItem,
  ProjectMemoryProvenance,
  ProjectMemoryScope,
  ProjectMemoryValue,
  ProjectMemoryCategory,
  ProjectMemoryConfidence,
  ProjectMemoryStatus,
} from '@project-x/types';

export function scopeFingerprint(scope: ProjectMemoryScope): string {
  return JSON.stringify(scope);
}

export function toProjectMemoryItem(row: ProjectMemoryRow): ProjectMemoryItem {
  const value = row.valueJson as unknown as ProjectMemoryValue;
  const scope = row.scopeJson as unknown as ProjectMemoryScope;
  const provenance = row.provenanceJson as unknown as ProjectMemoryProvenance[];
  const freshness =
    row.freshnessJson == null
      ? undefined
      : (row.freshnessJson as unknown as ProjectMemoryFreshness);

  return {
    id: row.id,
    project: {
      provider: 'github',
      owner: row.owner,
      repository: row.repository,
    },
    category: row.category as ProjectMemoryCategory,
    key: row.key,
    value,
    confidence: row.confidence as ProjectMemoryConfidence,
    status: row.status as ProjectMemoryStatus,
    provenance: Array.isArray(provenance) ? provenance : [],
    scope,
    ...(freshness ? { freshness } : {}),
    ...(row.supersedesMemoryId ? { supersedesMemoryId: row.supersedesMemoryId } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(row.lastConfirmedAt ? { lastConfirmedAt: row.lastConfirmedAt.toISOString() } : {}),
  };
}
