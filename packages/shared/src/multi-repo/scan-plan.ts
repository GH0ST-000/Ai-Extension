import { MULTI_REPO_MAX_FILE_BYTES, MULTI_REPO_MAX_FILES_PER_REPO } from '@project-x/types';

import { looksLikeOpenApiPath } from './openapi-detect';
import { SERVICE_MANIFEST_PATH } from './manifest-detect';

/**
 * Which files of a repository tree to read for relationship discovery. Pure and bounded: it
 * only ranks the entries GitHub listed; reading them is the caller's job.
 */

export interface TreeEntry {
  path: string;
  type: 'blob' | 'tree' | 'commit' | string;
  size?: number;
  sha?: string;
}

export interface ScanPlan {
  selected: TreeEntry[];
  /** Relevant files skipped because they exceed the per-file size cap. */
  oversized: number;
  /** Relevant files left out because the file budget was reached. */
  overBudget: number;
  /** Relevant files found in the listing. */
  eligible: number;
}

const EXCLUDED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.output',
  '.turbo',
  '.cache',
  '.git',
  'vendor',
  'vendors',
  'third_party',
  'third-party',
  'generated',
  '__generated__',
  'test',
  'tests',
  '__tests__',
  '__mocks__',
  'e2e',
  'fixtures',
  'mocks',
  'examples',
  'storybook-static',
]);
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i;
const EXCLUDED_FILE =
  /(\.d\.ts|\.(spec|test|stories)\.[cm]?[jt]sx?|\.min\.js|\.bundle\.js|\.map)$/i;
const PREFERRED_DIRS = /^(src|app|lib|server|api|routes|services|clients?|packages\/[^/]+\/src)\//i;
const NAME_HINT =
  /(client|api|service|route|router|controller|server|app|index|main|http|fetch|request|gateway|users?)/i;

function isExcludedPath(path: string): boolean {
  const parts = path.split('/');
  return parts.slice(0, -1).some((dir) => EXCLUDED_DIRS.has(dir.toLowerCase()));
}

/** 0 = root signal file, 1 = OpenAPI elsewhere, 2 = preferred source, 3 = other source. */
function tier(path: string): number | null {
  const lower = path.toLowerCase();
  if (!path.includes('/')) {
    if (lower === 'package.json' || lower === 'readme.md' || lower === SERVICE_MANIFEST_PATH)
      return 0;
    if (looksLikeOpenApiPath(path)) return 0;
  }
  if (isExcludedPath(path)) return null;
  if (looksLikeOpenApiPath(path) && path.split('/').length <= 3) return 1;
  if (!SOURCE_EXT.test(path) || EXCLUDED_FILE.test(path)) return null;
  const file = path.split('/').pop()!;
  return PREFERRED_DIRS.test(path) && NAME_HINT.test(file) ? 2 : PREFERRED_DIRS.test(path) ? 3 : 4;
}

export function planRepositoryScan(
  entries: TreeEntry[],
  maxFiles: number = MULTI_REPO_MAX_FILES_PER_REPO,
  maxFileBytes: number = MULTI_REPO_MAX_FILE_BYTES,
): ScanPlan {
  const ranked: Array<{ entry: TreeEntry; tier: number; depth: number }> = [];
  let oversized = 0;
  for (const entry of entries) {
    if (entry.type !== 'blob' || typeof entry.path !== 'string') continue;
    const t = tier(entry.path);
    if (t === null) continue;
    if (typeof entry.size === 'number' && entry.size > maxFileBytes) {
      oversized += 1;
      continue;
    }
    ranked.push({ entry, tier: t, depth: entry.path.split('/').length });
  }
  ranked.sort(
    (a, b) => a.tier - b.tier || a.depth - b.depth || a.entry.path.localeCompare(b.entry.path),
  );
  const budget = Math.max(0, maxFiles);
  return {
    selected: ranked.slice(0, budget).map((r) => r.entry),
    oversized,
    overBudget: Math.max(0, ranked.length - budget),
    eligible: ranked.length + oversized,
  };
}
