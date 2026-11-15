import { escapeRegExp } from '@project-x/shared';
import {
  PR_REVIEW_COVERAGE_MARKER,
  PR_REVIEW_FILE_STATUSES,
  PR_REVIEW_INCOMPLETE_MARKER,
  type PRReviewBatchOutcome,
  type PRReviewCoverage,
  type PRReviewCoverageFile,
  type PRReviewFileStatus,
  type PRReviewRiskLevel,
} from '@project-x/types';

const COVERAGE_RE = new RegExp(
  String.raw`\s*${escapeRegExp(PR_REVIEW_COVERAGE_MARKER)}\s+([A-Za-z0-9_-]+)\]\]\s*$`,
);
const INCOMPLETE_RE = new RegExp(
  String.raw`\s*${escapeRegExp(PR_REVIEW_INCOMPLETE_MARKER)}\s+reason=([a-z-]+)\]\]\s*$`,
  'i',
);

/** Coverage was reported partial by the server (handled by the coverage banner). */
export const PARTIAL_COVERAGE_REASON = 'partial-coverage';

const MAX_FILES = 3_000;
const MAX_BATCHES = 24;
const STATUS_SET = new Set<string>(PR_REVIEW_FILE_STATUSES);
const RISK_SET = new Set<PRReviewRiskLevel>(['high', 'medium', 'low', 'unknown']);

function decodeBase64UrlUtf8(value: string): string {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

const count = (n: unknown): number | null =>
  typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : null;

/** Newer optional quality statistics; kept only when they are valid counts. */
function optionalCounts(
  fr: Partial<PRReviewCoverage['findings']>,
): Partial<PRReviewCoverage['findings']> {
  const out: Partial<PRReviewCoverage['findings']> = {};
  for (const key of [
    'needsInvestigation',
    'dismissed',
    'crossFileMerged',
    'severityAdjusted',
  ] as const) {
    const n = count(fr[key]);
    if (n !== null) out[key] = n;
  }
  const v = fr.verification;
  if (v && typeof v === 'object') {
    const fields = [
      'attempted',
      'confirmed',
      'refuted',
      'insufficientContext',
      'unavailable',
    ] as const;
    const values = fields.map((f) => count((v as Record<string, unknown>)[f]));
    if (values.every((n) => n !== null)) {
      const verification = Object.fromEntries(fields.map((f, i) => [f, values[i]])) as NonNullable<
        PRReviewCoverage['findings']['verification']
      >;
      for (const extra of [
        'withDiffWindow',
        'withHeadContext',
        'withHelpers',
        'unprovenConfirmations',
      ] as const) {
        const n = count((v as Record<string, unknown>)[extra]);
        if (n !== null) verification[extra] = n;
      }
      out.verification = verification;
    }
  }
  return out;
}

/**
 * Decode and validate the coverage trailer. Strict: unknown statuses, malformed numbers or
 * shapes make the whole manifest invalid (null), so the UI never shows guessed coverage.
 */
export function decodePrReviewCoverage(encoded: string): PRReviewCoverage | null {
  let raw: Partial<PRReviewCoverage> & Record<string, unknown>;
  try {
    raw = JSON.parse(decodeBase64UrlUtf8(encoded)) as typeof raw;
  } catch {
    return null;
  }
  if (!raw || raw.version !== 1 || typeof raw.complete !== 'boolean') return null;
  if (raw.source !== 'github_api' && raw.source !== 'page') return null;
  if (!RISK_SET.has(raw.riskLevel as PRReviewRiskLevel)) return null;
  if (raw.usageUnits !== 0 && raw.usageUnits !== 1) return null;

  const counts = {} as Record<PRReviewFileStatus, number>;
  for (const status of PR_REVIEW_FILE_STATUSES) {
    const n = count((raw.counts as Record<string, unknown> | undefined)?.[status]);
    if (n === null) return null;
    counts[status] = n;
  }

  if (!Array.isArray(raw.files) || raw.files.length > MAX_FILES) return null;
  const files: PRReviewCoverageFile[] = [];
  for (const file of raw.files as unknown[]) {
    const f = file as Partial<PRReviewCoverageFile>;
    if (typeof f?.path !== 'string' || !f.path || f.path.length > 1_000) return null;
    if (!STATUS_SET.has(f.status as string)) return null;
    files.push({
      path: f.path,
      status: f.status as PRReviewFileStatus,
      priority: count(f.priority) ?? 0,
      patchChars: count(f.patchChars) ?? 0,
      reviewedChars: count(f.reviewedChars) ?? 0,
    });
  }

  if (!Array.isArray(raw.batches) || raw.batches.length > MAX_BATCHES) return null;
  const batches: PRReviewBatchOutcome[] = [];
  for (const batch of raw.batches as unknown[]) {
    const b = batch as Partial<PRReviewBatchOutcome>;
    if (typeof b?.id !== 'string') return null;
    if (b.status !== 'succeeded' && b.status !== 'failed' && b.status !== 'cancelled') return null;
    batches.push({
      id: b.id.slice(0, 16),
      status: b.status,
      attempts: count(b.attempts) ?? 0,
      files: count(b.files) ?? 0,
      ...(typeof b.errorCode === 'string' ? { errorCode: b.errorCode.slice(0, 40) } : {}),
    });
  }

  const fr = (raw.findings ?? {}) as Partial<PRReviewCoverage['findings']>;
  const rejectedByReason: Record<string, number> = {};
  for (const [k, v] of Object.entries(fr.rejectedByReason ?? {})) {
    const n = count(v);
    if (n !== null && /^[a-z_]{1,40}$/.test(k)) rejectedByReason[k] = n;
  }

  const total = raw.totalFiles === null ? null : count(raw.totalFiles);
  if (raw.totalFiles !== null && total === null) return null;

  return {
    version: 1,
    source: raw.source,
    totalFiles: total,
    complete: raw.complete,
    counts,
    files,
    batches,
    findings: {
      accepted: count(fr.accepted) ?? 0,
      duplicates: count(fr.duplicates) ?? 0,
      rejected: count(fr.rejected) ?? 0,
      rejectedByReason,
      linesCorrected: count(fr.linesCorrected) ?? 0,
      ...optionalCounts(fr),
    },
    riskLevel: raw.riskLevel as PRReviewRiskLevel,
    usageUnits: raw.usageUnits,
  };
}

/**
 * Remove the API trailers (coverage manifest and incomplete marker, in either order) from
 * the end of a PR review response.
 */
export function stripPrReviewTrailers(content: string): {
  text: string;
  incompleteReason: string | null;
  coverage: PRReviewCoverage | null;
} {
  let text = content;
  let incompleteReason: string | null = null;
  let coverage: PRReviewCoverage | null = null;
  for (let i = 0; i < 2; i += 1) {
    const inc = INCOMPLETE_RE.exec(text);
    if (inc) {
      incompleteReason = inc[1]!.toLowerCase();
      text = text.slice(0, inc.index);
      continue;
    }
    const cov = COVERAGE_RE.exec(text);
    if (cov) {
      coverage = decodePrReviewCoverage(cov[1]!);
      text = text.slice(0, cov.index);
      continue;
    }
    break;
  }
  return { text, incompleteReason, coverage };
}

export type CoverageGap = { status: PRReviewFileStatus; label: string; count: number };

const GAP_LABELS: Partial<Record<PRReviewFileStatus, string>> = {
  reviewed_partial: 'partially reviewed',
  deferred_budget: 'deferred (review budget reached)',
  review_failed: 'not reviewed (AI batch failed)',
  no_patch: 'no diff available from GitHub',
  not_fetched: 'not listed by GitHub',
};

/** Non-zero reasons reviewable code was not fully covered, in display order. */
export function coverageGaps(coverage: PRReviewCoverage): CoverageGap[] {
  return (Object.keys(GAP_LABELS) as PRReviewFileStatus[])
    .filter((status) => coverage.counts[status] > 0)
    .map((status) => ({ status, label: GAP_LABELS[status]!, count: coverage.counts[status] }));
}

/** Files that were not fully reviewed (excluding intentional exclusions), highest priority first. */
export function unreviewedFiles(coverage: PRReviewCoverage): PRReviewCoverageFile[] {
  const gap = new Set(Object.keys(GAP_LABELS));
  return coverage.files
    .filter((f) => gap.has(f.status))
    .sort((a, b) => b.priority - a.priority || a.path.localeCompare(b.path));
}

export function excludedCount(coverage: PRReviewCoverage): number {
  const c = coverage.counts;
  return c.excluded_generated + c.excluded_binary + c.excluded_no_changes;
}

/**
 * Shown wherever coverage is reported (report view, exports) when the diff came from the
 * GitHub page instead of the GitHub API.
 */
export const PAGE_FALLBACK_NOTICE =
  "Files were collected from the GitHub page because the GitHub API was unavailable. The PR's total number of changed files is unknown, so coverage cannot be verified and risk is not rated LOW.";

/**
 * A review whose files came from the GitHub page with no known total: the page can omit files
 * GitHub never rendered, so full coverage can never be claimed for it.
 */
export function isUnverifiedPageScope(
  scope: { source?: string | null; totalFiles?: number | null } | null | undefined,
): boolean {
  return scope?.source === 'page' && (scope.totalFiles === null || scope.totalFiles === undefined);
}
