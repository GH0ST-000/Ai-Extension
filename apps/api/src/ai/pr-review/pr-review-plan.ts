import type { PRReviewDiffSource } from '@project-x/types';

import { chunkPatch, type PatchChunk } from './diff-hunks';
import {
  categorizeFile,
  compareByPriority,
  filePriority,
  type ChangedFile,
  type FileCategory,
} from './pr-review-files';

/** Server-side limits for one PR review. Validated in config and re-clamped here. */
export type PrReviewLimits = {
  /** Maximum model batches per review (each batch = 1 call, +1 retry when transient). */
  maxBatches: number;
  /** Maximum model calls running at once. */
  concurrency: number;
  /** Estimated input tokens per batch (prompt overhead + diffs). */
  batchInputTokens: number;
  /** Estimated input tokens per review, across all batches. */
  maxInputTokens: number;
  /** Output tokens per batch call. */
  maxOutputTokensPerBatch: number;
  /** Output tokens per review, across all batches. */
  maxTotalOutputTokens: number;
  /** Per batch call timeout. */
  batchTimeoutMs: number;
  /** Whole review deadline (batches not finished by then are cancelled). */
  reviewTimeoutMs: number;
  /** Independent verification calls per review (MEDIUM/HIGH candidates, highest first). */
  maxVerifications: number;
  /** Input tokens per verification call (prompt is trimmed to fit). */
  verifyInputTokens: number;
  /** Output tokens per verification call. */
  verifyOutputTokens: number;
  /** Files fetched at the PR head for read-only code context, per review. */
  maxContextFiles: number;
};

/** Absolute ceilings that no configuration can exceed. */
export const PR_REVIEW_HARD_LIMITS = {
  maxBatches: 12,
  concurrency: 6,
  batchInputTokens: 60_000,
  maxInputTokens: 400_000,
  maxOutputTokensPerBatch: 16_384,
  maxTotalOutputTokens: 100_000,
  maxVerifications: 24,
  verifyInputTokens: 20_000,
  verifyOutputTokens: 4_000,
  maxContextFiles: 30,
} as const;

export const DEFAULT_PR_REVIEW_LIMITS: PrReviewLimits = {
  maxBatches: 6,
  concurrency: 3,
  batchInputTokens: 16_000,
  maxInputTokens: 96_000,
  maxOutputTokensPerBatch: 4_096,
  maxTotalOutputTokens: 24_576,
  batchTimeoutMs: 120_000,
  reviewTimeoutMs: 240_000,
  maxVerifications: 10,
  verifyInputTokens: 6_000,
  verifyOutputTokens: 800,
  maxContextFiles: 12,
};

/** Code is denser than prose; 3 chars/token over-estimates tokens, keeping budgets safe. */
export const CHARS_PER_TOKEN = 3;

export function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

/** Clamp any (possibly hand-built) limits into the hard ceilings. */
export function sanitizeLimits(input: Partial<PrReviewLimits> | undefined): PrReviewLimits {
  const d = DEFAULT_PR_REVIEW_LIMITS;
  const h = PR_REVIEW_HARD_LIMITS;
  const batchInputTokens = clampInt(
    input?.batchInputTokens,
    2_000,
    h.batchInputTokens,
    d.batchInputTokens,
  );
  const maxOutputTokensPerBatch = clampInt(
    input?.maxOutputTokensPerBatch,
    500,
    h.maxOutputTokensPerBatch,
    d.maxOutputTokensPerBatch,
  );
  return {
    maxBatches: clampInt(input?.maxBatches, 1, h.maxBatches, d.maxBatches),
    concurrency: clampInt(input?.concurrency, 1, h.concurrency, d.concurrency),
    batchInputTokens,
    maxInputTokens: clampInt(
      input?.maxInputTokens,
      batchInputTokens,
      h.maxInputTokens,
      d.maxInputTokens,
    ),
    maxOutputTokensPerBatch,
    maxTotalOutputTokens: clampInt(
      input?.maxTotalOutputTokens,
      maxOutputTokensPerBatch,
      h.maxTotalOutputTokens,
      d.maxTotalOutputTokens,
    ),
    batchTimeoutMs: clampInt(input?.batchTimeoutMs, 5_000, 300_000, d.batchTimeoutMs),
    reviewTimeoutMs: clampInt(input?.reviewTimeoutMs, 10_000, 600_000, d.reviewTimeoutMs),
    maxVerifications: clampInt(input?.maxVerifications, 0, h.maxVerifications, d.maxVerifications),
    verifyInputTokens: clampInt(
      input?.verifyInputTokens,
      2_000,
      h.verifyInputTokens,
      d.verifyInputTokens,
    ),
    verifyOutputTokens: clampInt(
      input?.verifyOutputTokens,
      300,
      h.verifyOutputTokens,
      d.verifyOutputTokens,
    ),
    maxContextFiles: clampInt(input?.maxContextFiles, 0, h.maxContextFiles, d.maxContextFiles),
  };
}

/** Batches allowed by every ceiling (count, total input, total output). */
export function effectiveMaxBatches(limits: PrReviewLimits): number {
  return Math.max(
    0,
    Math.min(
      limits.maxBatches,
      Math.floor(limits.maxInputTokens / limits.batchInputTokens),
      Math.floor(limits.maxTotalOutputTokens / limits.maxOutputTokensPerBatch),
    ),
  );
}

export type PlannedFile = {
  path: string;
  status: string;
  category: FileCategory;
  priority: number;
  patchChars: number;
  chunks: PatchChunk[];
  /** Chunk indices assigned to a batch. */
  plannedChunks: number[];
  /** A single line was longer than the chunk budget and was cut. */
  lineCut: boolean;
  /** Patch is a page-scraped excerpt, never the full diff. */
  excerpt: boolean;
};

export type PlannedUnit = {
  path: string;
  chunkIndex: number;
  chunkCount: number;
  chunk: PatchChunk;
};

export type PlannedBatch = { id: string; units: PlannedUnit[]; diffChars: number };

export type PrReviewPlan = {
  source: PRReviewDiffSource;
  totalFiles: number | null;
  /** Files GitHub counted but the listing did not return (beyond the pagination limit). */
  notFetched: number;
  /** All known files, in review priority order. */
  files: PlannedFile[];
  batches: PlannedBatch[];
  /** Diff characters each batch may hold (after prompt overhead). */
  batchDiffBudgetChars: number;
  estimatedInputTokens: number;
};

/** Per-unit framing added around each chunk in the prompt (path, chunk label). */
export function unitOverheadChars(path: string): number {
  return path.length + 48;
}

export function unitChars(unit: Pick<PlannedUnit, 'path' | 'chunk'>): number {
  return unit.chunk.text.length + unitOverheadChars(unit.path);
}

/** Minimum diff room per batch; below this, prompt overhead leaves no useful space. */
const MIN_BATCH_DIFF_CHARS = 1_500;

/**
 * Deterministically decide which diff chunks each batch reviews.
 *
 * 1. Files are classified; only `reviewable` files have chunks.
 * 2. Files are ordered by priority (security/infra source first), never by GitHub order.
 * 3. Oversized patches are split into chunks no larger than one batch's diff budget.
 * 4. Pass 1 places each file's chunks up to a per-file share (two batches' worth), so a single
 *    huge file cannot starve the rest of the PR; pass 2 spends any leftover budget on the
 *    remaining chunks of capped files.
 * 5. Chunks that fit nowhere are deferred — recorded, never dropped.
 */
export function planPrReview(input: {
  files: ChangedFile[];
  totalFiles: number | null;
  source: PRReviewDiffSource;
  /** Characters of prompt sent with every batch besides diffs (instructions, memory, file list). */
  overheadChars: number;
  limits: PrReviewLimits;
}): PrReviewPlan {
  const limits = sanitizeLimits(input.limits);
  const maxBatches = effectiveMaxBatches(limits);
  const batchDiffBudgetChars = Math.max(
    0,
    limits.batchInputTokens * CHARS_PER_TOKEN - Math.max(0, input.overheadChars),
  );
  const canBatch = maxBatches > 0 && batchDiffBudgetChars >= MIN_BATCH_DIFF_CHARS;

  const files: PlannedFile[] = input.files
    .map((file) => ({ ...file, priority: filePriority(file) }))
    .sort(compareByPriority)
    .map((file) => {
      const category = categorizeFile(file);
      const patch = file.patch ?? '';
      const chunkBudget = Math.max(200, batchDiffBudgetChars - unitOverheadChars(file.path));
      const chunks = category === 'reviewable' && canBatch ? chunkPatch(patch, chunkBudget) : [];
      return {
        path: file.path,
        status: file.status,
        category,
        priority: file.priority,
        patchChars: patch.length,
        chunks,
        plannedChunks: [],
        lineCut: chunks.some((c) => c.lineCut),
        excerpt: input.source === 'page',
      };
    });

  const batches: PlannedBatch[] = [];
  const place = (file: PlannedFile, chunkIndex: number): boolean => {
    const unit: PlannedUnit = {
      path: file.path,
      chunkIndex,
      chunkCount: file.chunks.length,
      chunk: file.chunks[chunkIndex]!,
    };
    const size = unitChars(unit);
    let target = batches.find((b) => b.diffChars + size <= batchDiffBudgetChars);
    if (!target && batches.length < maxBatches && size <= batchDiffBudgetChars) {
      target = { id: `b${batches.length + 1}`, units: [], diffChars: 0 };
      batches.push(target);
    }
    if (!target) return false;
    target.units.push(unit);
    target.diffChars += size;
    file.plannedChunks.push(chunkIndex);
    return true;
  };

  if (canBatch) {
    const perFileShare = batchDiffBudgetChars * 2;
    const leftovers: { file: PlannedFile; from: number }[] = [];
    for (const file of files) {
      let used = 0;
      for (let i = 0; i < file.chunks.length; i += 1) {
        const size = file.chunks[i]!.text.length + unitOverheadChars(file.path);
        if (i > 0 && used + size > perFileShare) {
          leftovers.push({ file, from: i });
          break;
        }
        if (!place(file, i)) break; // keep chunk order: later chunks stay deferred
        used += size;
      }
    }
    for (const { file, from } of leftovers) {
      for (let i = from; i < file.chunks.length; i += 1) {
        if (!place(file, i)) break;
      }
    }
  }

  // Keep chunks of the same file adjacent and in order inside each batch.
  for (const batch of batches) {
    const order = new Map(files.map((f, i) => [f.path, i]));
    batch.units.sort(
      (a, b) => order.get(a.path)! - order.get(b.path)! || a.chunkIndex - b.chunkIndex,
    );
  }

  const estimatedInputTokens = batches.reduce(
    (sum, b) => sum + estimateTokens(b.diffChars + Math.max(0, input.overheadChars)),
    0,
  );

  return {
    source: input.source,
    totalFiles: input.totalFiles,
    notFetched: input.totalFiles != null ? Math.max(0, input.totalFiles - input.files.length) : 0,
    files,
    batches,
    batchDiffBudgetChars,
    estimatedInputTokens,
  };
}
