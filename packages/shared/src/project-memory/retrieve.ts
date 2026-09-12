import type { ProjectMemoryCategory, ProjectMemoryItem } from '@project-x/types';

export type SelectRelevantMemoryOptions = {
  categories?: ProjectMemoryCategory[];
  pathHints?: string[];
  maxItems: number;
  maxChars: number;
};

function scopeScore(item: ProjectMemoryItem, pathHints: string[]): number {
  const scope = item.scope;
  if (scope.type === 'file-pattern' && pathHints.length > 0) {
    const matched = pathHints.some((hint) => pathMatchesPattern(hint, scope.pattern));
    return matched ? 50 : 5;
  }
  if (scope.type === 'directory' && pathHints.length > 0) {
    const dir = scope.path.replace(/\\/g, '/').replace(/\/$/, '');
    const matched = pathHints.some((hint) => {
      const h = hint.replace(/\\/g, '/');
      return h === dir || h.startsWith(`${dir}/`);
    });
    return matched ? 40 : 8;
  }
  if (scope.type === 'service') return 20;
  if (scope.type === 'user-project') return 18;
  if (scope.type === 'repository') return 10;
  return 0;
}

function pathMatchesPattern(path: string, pattern: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  // Minimal glob: * and ** support for common file-pattern scopes
  const escaped = pattern
    .replace(/\\/g, '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, ':::DS:::')
    .replace(/\*/g, '[^/]*')
    .replace(/:::DS:::/g, '.*');
  try {
    return new RegExp(`^${escaped}$`).test(normalized);
  } catch {
    return normalized.includes(pattern);
  }
}

function confidenceScore(item: ProjectMemoryItem): number {
  if (item.confidence === 'high') return 30;
  if (item.confidence === 'medium') return 15;
  return 5;
}

function provenanceScore(item: ProjectMemoryItem): number {
  if (item.provenance.some((p) => p.type === 'user_explicit')) return 40;
  if (item.provenance.some((p) => p.type === 'repository_observation')) return 20;
  if (item.provenance.some((p) => p.type === 'project_setting')) return 25;
  return 10;
}

function itemChars(item: ProjectMemoryItem): number {
  return (
    item.key.length +
    item.value.summary.length +
    item.category.length +
    (item.value.details ? JSON.stringify(item.value.details).length : 0)
  );
}

/**
 * Select active, relevant memory within budgets.
 * Prefers user_explicit, high confidence, and narrower matching scopes.
 */
export function selectRelevantMemory(
  items: ProjectMemoryItem[],
  opts: SelectRelevantMemoryOptions,
): ProjectMemoryItem[] {
  const maxItems = Math.max(0, opts.maxItems);
  const maxChars = Math.max(0, opts.maxChars);
  const pathHints = opts.pathHints ?? [];
  const categorySet = opts.categories ? new Set(opts.categories) : null;

  const eligible = items.filter((item) => {
    if (item.status !== 'active') return false;
    if (categorySet && !categorySet.has(item.category)) return false;
    return true;
  });

  const ranked = eligible
    .map((item) => ({
      item,
      score: provenanceScore(item) + confidenceScore(item) + scopeScore(item, pathHints),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.item.key.localeCompare(b.item.key);
    });

  const selected: ProjectMemoryItem[] = [];
  let usedChars = 0;

  for (const { item } of ranked) {
    if (selected.length >= maxItems) break;
    const chars = itemChars(item);
    if (usedChars + chars > maxChars) continue;
    selected.push(item);
    usedChars += chars;
  }

  return selected;
}
