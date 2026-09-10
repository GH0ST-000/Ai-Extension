import { GITHUB_PATCH_MAX_PATH_CHARACTERS } from '@project-x/types';

/**
 * Normalize and validate a repository-relative path for Day 14 writes.
 * Rejects traversal, absolute paths, and empty/malformed targets.
 */
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

export function countLineDiff(
  original: string,
  next: string,
): { additions: number; deletions: number } {
  const a = original.replace(/\r\n/g, '\n').split('\n');
  const b = next.replace(/\r\n/g, '\n').split('\n');
  // Simple LCS-ish line counts for preview stats (not a full diff algorithm).
  const aSet = new Map<string, number>();
  for (const line of a) {
    aSet.set(line, (aSet.get(line) ?? 0) + 1);
  }
  let common = 0;
  for (const line of b) {
    const count = aSet.get(line) ?? 0;
    if (count > 0) {
      common += 1;
      aSet.set(line, count - 1);
    }
  }
  return {
    additions: Math.max(0, b.length - common),
    deletions: Math.max(0, a.length - common),
  };
}

export function buildUnifiedDiffPreview(
  path: string,
  original: string,
  next: string,
  maxLines = 200,
): string {
  const a = original.replace(/\r\n/g, '\n').split('\n');
  const b = next.replace(/\r\n/g, '\n').split('\n');
  const lines: string[] = [`--- a/${path}`, `+++ b/${path}`];
  const max = Math.max(a.length, b.length);
  let emitted = 0;
  for (let i = 0; i < max && emitted < maxLines; i += 1) {
    const left = a[i];
    const right = b[i];
    if (left === right) {
      if (left !== undefined) {
        lines.push(` ${left}`);
        emitted += 1;
      }
      continue;
    }
    if (left !== undefined) {
      lines.push(`-${left}`);
      emitted += 1;
    }
    if (right !== undefined && emitted < maxLines) {
      lines.push(`+${right}`);
      emitted += 1;
    }
  }
  if (emitted >= maxLines) {
    lines.push('… (diff truncated for preview)');
  }
  return lines.join('\n');
}
