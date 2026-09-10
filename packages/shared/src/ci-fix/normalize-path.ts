import { GITHUB_PATCH_MAX_PATH_CHARACTERS } from '@project-x/types';

/** Normalize repository-relative paths (Day 14 / Day 16 shared). */
export function normalizeRepositoryPath(raw: string): string | null {
  const trimmed = raw.trim().replace(/\\/g, '/');
  if (!trimmed || trimmed.length > GITHUB_PATCH_MAX_PATH_CHARACTERS) {
    return null;
  }
  if (trimmed.startsWith('/') || trimmed.includes('\0')) {
    return null;
  }
  if (/^[a-zA-Z]:/.test(trimmed)) {
    return null;
  }

  const segments = trimmed.split('/');
  const normalized: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === '.') {
      continue;
    }
    if (segment === '..') {
      return null;
    }
    normalized.push(segment);
  }

  if (normalized.length === 0) {
    return null;
  }

  return normalized.join('/');
}
