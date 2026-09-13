import { GITHUB_PATCH_MAX_PATH_CHARACTERS } from '@project-x/types';

/** Normalize repository-relative paths (Day 14 / Day 16 shared). */
export function normalizeRepositoryPath(raw: string): string | null {
  let decoded = raw.trim();
  try {
    decoded = decodeURIComponent(decoded.replace(/\+/g, ' '));
  } catch {
    return null;
  }
  const trimmed = decoded.replace(/\\/g, '/');
  if (!trimmed || trimmed.length > GITHUB_PATCH_MAX_PATH_CHARACTERS) {
    return null;
  }
  if (trimmed.startsWith('/') || trimmed.includes('\0')) {
    return null;
  }
  if (/^[a-zA-Z]:/.test(trimmed)) {
    return null;
  }
  if (trimmed.includes('%')) {
    return null;
  }
  for (let i = 0; i < trimmed.length; i += 1) {
    const code = trimmed.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return null;
    }
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
