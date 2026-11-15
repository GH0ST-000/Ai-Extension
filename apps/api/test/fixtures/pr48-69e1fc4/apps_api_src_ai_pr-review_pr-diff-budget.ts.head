import type { PageContextChangedFile, PRReviewScope } from '@project-x/types';

/** GitHub `GET /pulls/{n}/files` item (fields we use). */
export type GitHubPullFile = {
  filename?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  changes?: number;
  /** Absent for binary files and for patches GitHub considers too large. */
  patch?: string;
};

/**
 * Budgets for the diff sent to the model. ~60k chars ≈ 15k input tokens: large enough for a
 * real multi-file review, small enough to stay well inside model context and cost limits.
 */
export const PR_DIFF_MAX_FILES = 40;
export const PR_DIFF_MAX_TOTAL_CHARS = 60_000;
export const PR_DIFF_MAX_FILE_CHARS = 8_000;
/** Pages of 100 files fetched from GitHub (GitHub itself caps the endpoint at 3000 files). */
export const PR_DIFF_MAX_PAGES = 3;

const GENERATED_FILE_RE =
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|composer\.lock|Cargo\.lock|poetry\.lock|go\.sum)$|\.min\.(js|css)$|(^|\/)(dist|build|vendor|node_modules)\/|\.snap$|\.map$/i;

export function isGeneratedOrLockFile(path: string): boolean {
  return GENERATED_FILE_RE.test(path);
}

function truncatePatch(patch: string, max: number): string {
  if (patch.length <= max) return patch;
  const cut = patch.lastIndexOf('\n', max);
  return `${patch.slice(0, cut > max / 2 ? cut : max)}\n… [diff truncated]`;
}

/**
 * Select which changed files (and how much of each patch) go to the model.
 * Reviewable source files come first; lockfiles/generated/binary files are listed by path
 * only and counted as skipped, so the scope numbers stay honest.
 */
export function budgetPullRequestFiles(
  files: GitHubPullFile[],
  totalFilesInPr: number | null,
): { changedFiles: PageContextChangedFile[]; scope: PRReviewScope } {
  const valid = files.filter((file): file is GitHubPullFile & { filename: string } =>
    Boolean(file.filename),
  );
  const reviewable = valid.filter((f) => f.patch && !isGeneratedOrLockFile(f.filename));
  const others = valid.filter((f) => !f.patch || isGeneratedOrLockFile(f.filename));

  const changedFiles: PageContextChangedFile[] = [];
  let usedChars = 0;
  let analyzed = 0;
  let linesCut = false;

  for (const file of reviewable) {
    if (changedFiles.length >= PR_DIFF_MAX_FILES) break;
    const remaining = PR_DIFF_MAX_TOTAL_CHARS - usedChars;
    if (remaining < 200) break;
    const limit = Math.min(PR_DIFF_MAX_FILE_CHARS, remaining);
    const patch = file.patch!;
    const excerpt = truncatePatch(patch, limit);
    if (excerpt.length < patch.length) linesCut = true;
    changedFiles.push({ path: file.filename, patchExcerpt: excerpt });
    usedChars += excerpt.length;
    analyzed += 1;
  }

  // Path-only entries tell the model these files exist without spending diff budget.
  for (const file of others) {
    if (changedFiles.length >= PR_DIFF_MAX_FILES) break;
    changedFiles.push({ path: file.filename });
  }

  const total = totalFilesInPr ?? valid.length;
  const skipped = Math.max(0, total - analyzed);
  return {
    changedFiles,
    scope: {
      source: 'github_api',
      totalFiles: total,
      analyzedFiles: analyzed,
      skippedFiles: skipped,
      truncated: skipped > 0 || linesCut,
    },
  };
}

/** Scope for the DOM fallback: we only know what the page rendered. */
export function scopeFromPageFiles(
  files: PageContextChangedFile[] | undefined,
  pageTruncated: boolean | undefined,
): PRReviewScope {
  const analyzed = (files ?? []).filter((f) => f.patchExcerpt?.trim()).length;
  const listed = files?.length ?? 0;
  return {
    source: 'page',
    totalFiles: null,
    analyzedFiles: analyzed,
    skippedFiles: listed - analyzed,
    truncated: Boolean(pageTruncated) || listed > analyzed,
  };
}
