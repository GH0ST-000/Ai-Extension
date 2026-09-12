import type { ProjectMemoryItem } from '@project-x/types';

type VersionItem = Pick<ProjectMemoryItem, 'id' | 'key' | 'updatedAt' | 'status'>;

/** Simple stable string hash (djb2) — no Node crypto dependency. */
function djb2(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  // unsigned 32-bit hex
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Stable fingerprint from active memory items.
 * Only `active` items participate; order-independent via sorted keys.
 */
export function computeMemoryVersion(items: VersionItem[]): string {
  const active = items
    .filter((item) => item.status === 'active')
    .map((item) => `${item.id}|${item.key}|${item.updatedAt}`)
    .sort();

  if (active.length === 0) {
    return `pmv-0-${djb2('empty')}`;
  }

  const payload = active.join('\n');
  return `pmv-${active.length}-${djb2(payload)}`;
}
