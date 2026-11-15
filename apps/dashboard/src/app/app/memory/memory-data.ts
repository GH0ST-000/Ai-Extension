import type { ProjectMemoryItem } from '@project-x/types';

import { getProjectMemoryProfile, listProjectMemory } from '../../../lib/api';

/**
 * Everything the Memory page shows for one repository. Active, disputed and archived rules are
 * fetched separately (the API filters by status), so non-active rules never mix into the active
 * list — and none of them reach AI context, which only ever loads active rules.
 */
export async function fetchMemory(owner: string, repo: string) {
  const [list, disputed, archived, profile] = await Promise.all([
    listProjectMemory(owner, repo),
    listProjectMemory(owner, repo, 'disputed'),
    listProjectMemory(owner, repo, 'archived'),
    getProjectMemoryProfile(owner, repo),
  ]);
  return { list, disputed: disputed.items, archived: archived.items, profile };
}

/** Where a rule came from, for the Disputed / Archived details. */
export function memorySourceLabel(item: Pick<ProjectMemoryItem, 'provenance'>): string {
  const types = new Set(item.provenance.map((p) => p.type));
  if (types.has('user_explicit')) return 'Saved by a workspace member';
  if (types.has('repository_observation')) return 'Learned from repository files';
  if (types.has('project_setting')) return 'From project settings';
  if (types.has('review_result') || types.has('workflow_result')) return 'Suggested by a review';
  return 'Unknown source';
}
