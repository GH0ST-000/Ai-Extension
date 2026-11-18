/**
 * Persistent PR Review History — immutable snapshots of completed, partial and failed
 * REVIEW_ENTIRE_PR executions. Reading history never calls the AI, never charges usage and
 * never writes to GitHub.
 */
import type {
  DownstreamImpactFinding,
  PRReviewCoverage,
  PRReviewDiffSource,
  PRReviewScope,
  RepositoryIdentity,
} from './index';

/** Current snapshot layout. Readers must accept every version up to this one. */
export const PR_REVIEW_REPORT_SCHEMA_VERSION = 1;

export const PR_REVIEW_REPORT_STATUSES = ['completed', 'partial', 'failed'] as const;
/**
 * - completed: every reviewable file was fully reviewed
 * - partial: a report was delivered (and charged) but coverage is incomplete
 * - failed: no batch succeeded; nothing was delivered and the usage unit was refunded
 */
export type PrReviewReportStatus = (typeof PR_REVIEW_REPORT_STATUSES)[number];

export type PrReviewReportSeverity = 'high' | 'medium' | 'low';

/** One finding exactly as it was reported (structured; evidence is capped). */
export interface PrReviewReportFinding {
  stableId: string;
  path: string;
  lineStart: number | null;
  lineEnd: number | null;
  category: string;
  severity: PrReviewReportSeverity;
  requestedSeverity: PrReviewReportSeverity;
  confidence: 'high' | 'medium' | 'low';
  title: string;
  explanation: string;
  /** Changed lines quoted by the finding (capped; never full files). */
  evidence: string;
  evidenceKind: 'changed' | 'context';
  changeType: string;
  impact: string;
  trigger: string;
  failurePath: string;
  verification: { status: string; reason?: string };
  /** `reported` or `needs_investigation` (dismissed candidates are counted, not stored). */
  disposition: 'reported' | 'needs_investigation';
  alsoIn: string[];
}

/** Shared (workspace-visible) Project Memory rule that was applied: identifiers only. */
export interface PrReviewReportSharedRule {
  id: string;
  key: string;
  category: string;
  confidence: string;
}

/**
 * Project Memory as the review ran. Never contains rule text; personal preferences are a
 * count only, and that count is shown only to the review's initiator.
 */
export interface PrReviewReportMemory {
  /** The setting the review ran with. */
  mode: 'on' | 'off';
  status: 'applied' | 'skipped' | 'disabled';
  requestSource?: 'explicit' | 'default';
  skipReason?: string;
  /** Rules that reached the prompt (for other viewers: shared rules only). */
  ruleCount: number;
  sharedRules: PrReviewReportSharedRule[];
  /** Personal preferences applied. Present only for the review's initiator. */
  personalRuleCount?: number;
}

export interface PrReviewReportSnapshot {
  version: number;
  coverage: PRReviewCoverage | null;
  reviewScope: PRReviewScope | null;
  findings: PrReviewReportFinding[];
  memory: PrReviewReportMemory | null;
  execution: {
    durationMs: number;
    batches: number;
    batchesSucceeded: number;
    batchesFailed: number;
  };
  /** Present for failed runs and for partial runs with failed batches. */
  failure?: { code: string; failedBatches: number };
  /**
   * Deterministic cross-repository contract impact (absent in reviews recorded before it
   * existed). Consumer details are re-authorized for each viewer when the report is read.
   */
  downstreamImpact?: PrReviewDownstreamImpact;
}

/**
 * State of the downstream impact analysis of one PR Review. Never inferred from an empty list:
 * - `verified`: breaking contract change(s) with potentially affected consumers;
 * - `no_known_consumers`: breaking change(s), but no consumer in the reviewer's Systems
 *   (NOT a statement that nothing depends on it);
 * - `compatible`: the contract changed without breaking changes;
 * - `not_analyzed`: no OpenAPI contract changed in this PR;
 * - `no_system`: breaking change(s), but the repository is in none of the reviewer's Systems;
 * - `unavailable`: the contract change could not be verified (retrieval, parsing, timeout);
 * - `partial`: some contracts or consumer checks could not be completed.
 */
export type PrReviewDownstreamImpactStatus =
  | 'verified'
  | 'no_known_consumers'
  | 'compatible'
  | 'not_analyzed'
  | 'no_system'
  | 'unavailable'
  | 'partial';

export type PrReviewImpactWarning =
  | 'stale_graph'
  | 'consumers_withheld'
  | 'access_check_unavailable'
  | 'no_personal_token'
  | 'contract_unavailable'
  | 'contract_unparseable'
  | 'contract_deleted'
  | 'contract_too_large'
  | 'too_many_contracts'
  | 'rate_limited'
  | 'timeout'
  | 'unverified_shas';

export interface PrReviewImpactContract {
  path: string;
  previousPath?: string;
  /** compared: both versions parsed; added/deleted: only one side exists. */
  status: 'compared' | 'added' | 'deleted' | 'unavailable' | 'unparseable';
  breaking: number;
  nonBreaking: number;
  uncertain: number;
}

export interface PrReviewDownstreamImpact {
  status: PrReviewDownstreamImpactStatus;
  provider: RepositoryIdentity;
  /** Immutable commits the contracts were read at (from GitHub PR metadata). */
  baseSha?: string;
  headSha?: string;
  contracts: PrReviewImpactContract[];
  /** Breaking operations and their potentially affected (and authorized) consumers. */
  findings: DownstreamImpactFinding[];
  /** Consumers hidden because the viewer's access to them could not be verified. */
  withheldConsumers: number;
  graph?: {
    relationshipsConsidered: number;
    oldestValidatedAt?: string;
    newestValidatedAt?: string;
    stale: boolean;
  };
  warnings: PrReviewImpactWarning[];
  /** When the analysis ran (review time). */
  analyzedAt: string;
}

/** List row: metadata only (no findings, no markdown). */
export interface PrReviewHistoryItem {
  id: string;
  schemaVersion: number;
  owner: string;
  repository: string;
  pullRequestNumber: number;
  pullRequestTitle: string | null;
  headSha: string | null;
  status: PrReviewReportStatus;
  failureCode: string | null;
  riskLevel: string | null;
  diffSource: PRReviewDiffSource | null;
  findingsCount: number;
  needsInvestigationCount: number;
  filesTotal: number | null;
  filesReviewed: number;
  coverageComplete: boolean;
  memoryMode: 'on' | 'off' | null;
  memoryStatus: string | null;
  /** True when the viewer ran this review. */
  initiatedByMe: boolean;
  /** Display name of the initiator (never an email address); null when deleted. */
  initiatorName: string | null;
  startedAt: string;
  completedAt: string;
  createdAt: string;
}

export interface PrReviewHistoryPage {
  /** Reports the viewer may open, newest first. May be shorter than `limit` (see below). */
  items: PrReviewHistoryItem[];
  /**
   * Opaque cursor; null only when the whole history was scanned. A page can be short (even
   * empty) with a non-null cursor when the per-request scan budget was reached — keep loading.
   */
  nextCursor: string | null;
  /**
   * True when reports were skipped on this page because the viewer cannot currently access
   * their repository through GitHub. No counts or names are disclosed.
   */
  someRepositoriesHidden: boolean;
  /**
   * True when GitHub could not confirm access for a repository right now: the page stops
   * before that report (nothing is skipped silently); retrying `nextCursor` continues there.
   */
  accessCheckIncomplete: boolean;
}

/**
 * Whether a review's history snapshot is stored, as confirmed by the database. `saved` is
 * reported only after PostgreSQL returned the row; `unknown` when that could not be confirmed.
 */
export type PrReviewHistoryPersistence =
  { status: 'saved'; reportId: string } | { status: 'not_saved' } | { status: 'unknown' };

export interface PrReviewReportDetail extends PrReviewHistoryItem {
  baseBranch: string | null;
  headBranch: string | null;
  snapshot: PrReviewReportSnapshot;
  /** Report as delivered (Markdown with the coverage trailer); null for failed runs. */
  reportMarkdown: string | null;
}

export interface PrReviewHistoryQuery {
  owner?: string;
  repository?: string;
  pullRequestNumber?: number;
  status?: PrReviewReportStatus;
  cursor?: string;
  limit?: number;
}

export const PR_REVIEW_HISTORY_MAX_LIMIT = 50;
export const PR_REVIEW_HISTORY_DEFAULT_LIMIT = 20;
