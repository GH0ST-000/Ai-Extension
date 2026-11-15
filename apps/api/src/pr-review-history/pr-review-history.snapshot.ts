import type {
  PRReviewBatchOutcome,
  PRReviewCoverage,
  PRReviewScope,
  PrReviewReportFinding,
  PrReviewReportMemory,
  PrReviewReportSnapshot,
  PrReviewReportStatus,
  ProjectMemoryPromptMetadata,
} from '@project-x/types';
import { PR_REVIEW_REPORT_SCHEMA_VERSION } from '@project-x/types';

import type { ValidatedFinding } from '../ai/pr-review/pr-review-findings';

/** Stored Markdown above this size is omitted (the structured snapshot is still kept). */
export const MAX_REPORT_MARKDOWN_CHARS = 1_000_000;
/** Findings stored per report (the engine already caps far below this). */
export const MAX_STORED_FINDINGS = 500;
const MAX_TEXT = 2_000;
const MAX_EVIDENCE = 1_000;
const MAX_TITLE = 300;
const MAX_ALSO_IN = 50;

/**
 * Snapshot of one PR review execution. `status`/`failureCode` are decided by the caller
 * from the run's outcome; everything else is derived here so it can be unit-tested.
 */
export interface PrReviewSnapshotInput {
  status: PrReviewReportStatus;
  failureCode?: string;
  coverage: PRReviewCoverage | null;
  reviewScope: PRReviewScope | null;
  findings: readonly ValidatedFinding[];
  outcomes: readonly PRReviewBatchOutcome[];
  memory?: ProjectMemoryPromptMetadata;
  durationMs: number;
  batchCount: number;
}

function cap(value: string | null | undefined, max: number): string {
  if (!value) return '';
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export function toStoredFinding(finding: ValidatedFinding): PrReviewReportFinding | null {
  if (finding.disposition !== 'reported' && finding.disposition !== 'needs_investigation') {
    return null;
  }
  return {
    stableId: cap(finding.stableId, 100),
    path: cap(finding.path, 1_000),
    lineStart: finding.lineStart,
    lineEnd: finding.lineEnd,
    category: finding.category,
    severity: finding.severity,
    requestedSeverity: finding.requestedSeverity,
    confidence: finding.confidence,
    title: cap(finding.title, MAX_TITLE),
    explanation: cap(finding.explanation, MAX_TEXT),
    evidence: cap(finding.evidence, MAX_EVIDENCE),
    evidenceKind: finding.evidenceKind,
    changeType: finding.changeType,
    impact: cap(finding.impact, MAX_TEXT),
    trigger: cap(finding.trigger, MAX_TEXT),
    failurePath: cap(finding.failurePath, MAX_TEXT),
    verification: {
      status: finding.verification.status,
      ...(finding.verification.reason
        ? { reason: cap(finding.verification.reason, MAX_TEXT) }
        : {}),
    },
    disposition: finding.disposition,
    alsoIn: finding.alsoIn.slice(0, MAX_ALSO_IN).map((p) => cap(p, 1_000)),
  };
}

/**
 * Project Memory metadata without any rule text. Personal (user-visibility) preferences are
 * reduced to a count: their ids and keys are never stored.
 */
export function toStoredMemory(
  metadata: ProjectMemoryPromptMetadata | undefined,
): PrReviewReportMemory | null {
  if (!metadata) return null;
  const mode = metadata.requested ?? (metadata.status === 'disabled' ? 'off' : 'on');
  const base = {
    mode,
    status: metadata.status,
    ...(metadata.requestSource ? { requestSource: metadata.requestSource } : {}),
  } as const;
  if (metadata.status !== 'applied') {
    return {
      ...base,
      ...(metadata.status === 'skipped' ? { skipReason: metadata.reason } : {}),
      ruleCount: 0,
      sharedRules: [],
      personalRuleCount: 0,
    };
  }
  const shared = metadata.rules.filter((rule) => rule.visibility === 'workspace');
  const personal = metadata.rules.length - shared.length;
  return {
    ...base,
    ruleCount: metadata.rules.length,
    sharedRules: shared.map((rule) => ({
      id: rule.id,
      key: rule.key,
      category: rule.category,
      confidence: rule.confidence,
    })),
    personalRuleCount: personal,
  };
}

export function buildPrReviewSnapshot(input: PrReviewSnapshotInput): PrReviewReportSnapshot {
  const findings = input.findings
    .map(toStoredFinding)
    .filter((f): f is PrReviewReportFinding => f !== null)
    .slice(0, MAX_STORED_FINDINGS);
  const failedBatches = input.outcomes.filter((o) => o.status !== 'succeeded').length;
  return {
    version: PR_REVIEW_REPORT_SCHEMA_VERSION,
    coverage: input.coverage,
    reviewScope: input.reviewScope,
    findings,
    memory: toStoredMemory(input.memory),
    execution: {
      durationMs: Math.max(0, Math.round(input.durationMs)),
      batches: input.batchCount,
      batchesSucceeded: input.outcomes.filter((o) => o.status === 'succeeded').length,
      batchesFailed: failedBatches,
    },
    ...(input.failureCode
      ? { failure: { code: input.failureCode, failedBatches } }
      : failedBatches > 0
        ? { failure: { code: 'some_batches_failed', failedBatches } }
        : {}),
  };
}

/**
 * Viewer-specific projection of the stored memory metadata: only the initiator learns that
 * personal preferences were applied (and how many). Other viewers — Owners included — see
 * shared rules only.
 */
export function memoryForViewer(
  memory: PrReviewReportMemory | null,
  viewerIsInitiator: boolean,
): PrReviewReportMemory | null {
  if (!memory) return null;
  if (viewerIsInitiator) return memory;
  const { personalRuleCount: _hidden, ...rest } = memory;
  return { ...rest, ruleCount: memory.sharedRules.length };
}

export function capMarkdown(text: string | null | undefined): string | null {
  if (!text) return null;
  return text.length > MAX_REPORT_MARKDOWN_CHARS ? null : text;
}
