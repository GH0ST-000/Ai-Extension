import {
  PR_REVIEW_FILE_STATUSES,
  PR_REVIEW_UNCOVERED_STATUSES,
  type PRReviewBatchOutcome,
  type PRReviewCoverage,
  type PRReviewCoverageFile,
  type PRReviewFileStatus,
  type PRReviewScope,
} from '@project-x/types';

import type { PlannedFile, PrReviewPlan } from './pr-review-plan';

function emptyCounts(): Record<PRReviewFileStatus, number> {
  return Object.fromEntries(PR_REVIEW_FILE_STATUSES.map((s) => [s, 0])) as Record<
    PRReviewFileStatus,
    number
  >;
}

/**
 * Final status of one file given which batches succeeded. A reviewable file is only
 * `reviewed_full` when every chunk was reviewed by a successful batch, no line was cut and
 * the patch is the real diff (not a page excerpt).
 */
function fileStatus(
  file: PlannedFile,
  okChunks: ReadonlySet<number>,
): { status: PRReviewFileStatus; reviewedChars: number } {
  if (file.category !== 'reviewable') {
    return { status: file.category, reviewedChars: 0 };
  }
  const succeededChunks = okChunks.size;
  const reviewedChars = file.chunks
    .filter((_, i) => okChunks.has(i))
    .reduce((sum, c) => sum + c.text.length, 0);
  if (
    succeededChunks > 0 &&
    succeededChunks === file.chunks.length &&
    !file.lineCut &&
    !file.excerpt
  ) {
    return { status: 'reviewed_full', reviewedChars: file.patchChars };
  }
  if (succeededChunks > 0) {
    return { status: 'reviewed_partial', reviewedChars: Math.min(reviewedChars, file.patchChars) };
  }
  if (file.plannedChunks.length > 0) return { status: 'review_failed', reviewedChars: 0 };
  return { status: 'deferred_budget', reviewedChars: 0 };
}

export function buildCoverage(input: {
  plan: PrReviewPlan;
  outcomes: PRReviewBatchOutcome[];
  findings: PRReviewCoverage['findings'];
  riskFor: (complete: boolean) => PRReviewCoverage['riskLevel'];
  usageUnits: 0 | 1;
}): PRReviewCoverage {
  const { plan, outcomes } = input;
  const succeeded = new Set(outcomes.filter((o) => o.status === 'succeeded').map((o) => o.id));

  // Chunks of each file reviewed by successful batches.
  const okChunks = new Map<string, Set<number>>();
  for (const batch of plan.batches) {
    if (!succeeded.has(batch.id)) continue;
    for (const unit of batch.units) {
      const set = okChunks.get(unit.path) ?? new Set<number>();
      set.add(unit.chunkIndex);
      okChunks.set(unit.path, set);
    }
  }

  const counts = emptyCounts();
  const files: PRReviewCoverageFile[] = plan.files.map((file) => {
    const { status, reviewedChars } = fileStatus(file, okChunks.get(file.path) ?? new Set());
    counts[status] += 1;
    return {
      path: file.path,
      status,
      priority: file.priority,
      patchChars: file.patchChars,
      reviewedChars,
    };
  });
  counts.not_fetched = plan.notFetched;

  const anyUncovered = PR_REVIEW_UNCOVERED_STATUSES.some((s) => counts[s] > 0);
  const anyBatchFailed = outcomes.some((o) => o.status !== 'succeeded');
  const complete = !anyUncovered && !anyBatchFailed && counts.reviewed_full > 0;

  return {
    version: 1,
    source: plan.source,
    totalFiles: plan.totalFiles,
    complete,
    counts,
    files,
    batches: outcomes,
    findings: input.findings,
    riskLevel: input.riskFor(complete),
    usageUnits: input.usageUnits,
  };
}

/**
 * Pre-review scope for the `X-PR-Review-Scope` header (sent before batches run). The final,
 * authoritative numbers are in the coverage trailer.
 */
export function scopeFromPlan(plan: PrReviewPlan): PRReviewScope {
  const planned = plan.files.filter((f) => f.plannedChunks.length > 0);
  const fullyPlanned = planned.filter(
    (f) => f.plannedChunks.length === f.chunks.length && !f.lineCut && !f.excerpt,
  );
  const known = plan.files.length + plan.notFetched;
  const total = plan.totalFiles ?? known;
  const uncovered =
    plan.notFetched > 0 ||
    plan.files.some((f) => f.category === 'no_patch') ||
    plan.files.some((f) => f.category === 'reviewable' && !fullyPlanned.includes(f));
  return {
    source: plan.source,
    totalFiles: plan.totalFiles,
    analyzedFiles: planned.length,
    skippedFiles: Math.max(0, total - planned.length),
    truncated: uncovered,
  };
}
