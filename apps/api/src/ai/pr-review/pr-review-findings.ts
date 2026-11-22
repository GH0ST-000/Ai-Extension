import { createHash } from 'node:crypto';
// zod 4's v3-compatible API: the JSON schema sent to the model stays exactly as pinned.
import { z } from 'zod/v3';
import type { PRReviewFindingSeverity, PRReviewRiskLevel } from '@project-x/types';

import {
  evidenceRange,
  isSubstantiveCode,
  matchEvidenceAll,
  type EvidenceMatch,
  rangeTouchesLines,
  type DiffLine,
} from './diff-hunks';
import type { PlannedBatch } from './pr-review-plan';
import { pathAsShownInPrompt } from './pr-review-prompt-path';

export const FINDING_CATEGORIES = [
  'security',
  'data_integrity',
  'availability',
  'correctness',
  'robustness',
  'test_gap',
  'maintainability',
  'observability',
] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

/**
 * How a finding relates to the PR:
 * - introduced: the defect is in code this PR adds or changes;
 * - removed_safeguard: this PR deletes a check/guard and nothing replaces it;
 * - exposed_existing: an existing defect that this PR's changes make reachable or worse
 *   (keeps its full severity);
 * - pre_existing: an existing issue the PR does not touch or expose (at most LOW).
 */
export const CHANGE_TYPES = [
  'introduced',
  'removed_safeguard',
  'exposed_existing',
  'pre_existing',
] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];
export type FindingConfidence = 'high' | 'medium' | 'low';

/** Only these impact categories can ever be HIGH. */
export const CRITICAL_CATEGORIES: ReadonlySet<FindingCategory> = new Set([
  'security',
  'data_integrity',
  'availability',
]);

/** Highest severity each category may carry, whatever the model (or project memory) asks for. */
export const CATEGORY_SEVERITY_CAP: Record<FindingCategory, PRReviewFindingSeverity> = {
  security: 'high',
  data_integrity: 'high',
  availability: 'high',
  correctness: 'medium',
  robustness: 'medium',
  test_gap: 'low',
  maintainability: 'low',
  // Missing logs / error details / debugging metadata: LOW unless operational impact is
  // demonstrated, which needs a different category (availability, correctness).
  observability: 'low',
};

/**
 * Structured output each batch must return. Every field is required (nullable or empty
 * string instead of optional) so the schema is valid for strict structured-output providers.
 */
export const batchFindingSchema = z.object({
  path: z.string().describe('Exact changed file path from this batch'),
  lineStart: z
    .number()
    .int()
    .nullable()
    .describe('First changed line (new file numbering; old numbering for removed lines)'),
  lineEnd: z.number().int().nullable().describe('Last line of the range, or null'),
  category: z.enum(FINDING_CATEGORIES),
  severity: z.enum(['high', 'medium', 'low']),
  confidence: z.enum(['high', 'medium', 'low']),
  title: z.string().describe('Short title of the defect'),
  explanation: z.string().describe('What is wrong, one to three sentences'),
  evidence: z.string().describe('1-5 lines copied verbatim from the diff that show the defect'),
  trigger: z
    .string()
    .describe('Concrete input, request or state that triggers the defect; empty if unknown'),
  failurePath: z
    .string()
    .describe('Steps from the trigger to the failure, citing path:line; empty if unknown'),
  violatedInvariant: z.string().describe('The rule or guarantee that is broken'),
  impact: z.string().describe('What goes wrong for users or data when triggered'),
  assumptions: z.string().describe('What you assumed but could not see; empty if none'),
  missingContext: z.string().describe('Code you would need to confirm this; empty if none'),
  changeType: z
    .enum(CHANGE_TYPES)
    .describe(
      'introduced | removed_safeguard (a deleted check with no replacement) | exposed_existing (old defect made reachable/worse by this PR) | pre_existing (unrelated to this PR)',
    ),
});

export const batchOutputSchema = z.object({
  summary: z.string().describe('One or two sentences on the risk of the files in this batch'),
  findings: z.array(batchFindingSchema),
});

export type BatchOutput = z.infer<typeof batchOutputSchema>;
export type BatchFindingInput = z.infer<typeof batchFindingSchema>;

export type VerificationStatus =
  | 'not_required'
  | 'pending'
  | 'confirmed'
  | 'refuted'
  | 'insufficient_context'
  | 'unavailable'
  /** LOW finding reported without independent confirmation (never shown as confirmed). */
  | 'unverified';

export type FindingDisposition = 'reported' | 'needs_investigation' | 'dismissed';

export type GateNote =
  | 'category_cap'
  | 'unsupported_failure_path'
  | 'no_trigger'
  | 'context_only_evidence'
  | 'line_mismatch'
  | 'verifier_lowered_severity'
  | 'pre_existing_cap'
  | 'reclassified_exposed_existing'
  | 'change_type_corrected'
  /** The claimed range contained the evidence but was much wider: narrowed to the evidence. */
  | 'line_range_narrowed'
  /** The claim repeats an applied Project Memory rule in wording the changed code lacks. */
  | 'memory_echo'
  /** Runtime claim in test-support code whose production reachability is unknown. */
  | 'test_reachability_unknown'
  /**
   * The quoted lines appear both as deleted and as added code (moved or re-indented): the
   * anchor follows the claim's change type, and the candidate is kept for verification.
   */
  | 'evidence_moved'
  /**
   * The quoted evidence is defensive code (guard, denial, catch, error report/log, fallback,
   * null return): a confirmation must show how it fails for a concrete input.
   */
  | 'defensive_evidence';

export type ValidatedFinding = {
  stableId: string;
  path: string;
  lineStart: number | null;
  lineEnd: number | null;
  /** The model's claimed range when it did not match the reviewed lines (recorded, not hidden). */
  claimedLines: { start: number; end: number } | null;
  category: FindingCategory;
  /** Severity the model asked for (memory or prompt pressure shows up here, not in `severity`). */
  requestedSeverity: PRReviewFindingSeverity;
  /** Severity after deterministic gates and verification. */
  severity: PRReviewFindingSeverity;
  confidence: FindingConfidence;
  title: string;
  explanation: string;
  evidence: string;
  evidenceKind: 'changed' | 'context';
  changeType: ChangeType;
  /**
   * Line at the PR head where the finding lives (for deleted-line evidence: the head line
   * that now follows the deleted code). Used to centre verification context.
   */
  headLine: number | null;
  trigger: string;
  failurePath: string;
  violatedInvariant: string;
  impact: string;
  assumptions: string;
  missingContext: string;
  gateNotes: GateNote[];
  verification: { status: VerificationStatus; reason?: string };
  disposition: FindingDisposition;
  /** Other files where the same root cause was reported (cross-file merge). */
  alsoIn: string[];
  batchId: string;
  /** Order within its batch, for deterministic tie-breaking. */
  ordinal: number;
};

export type RejectionReason =
  | 'path_not_in_batch'
  | 'evidence_not_in_diff'
  | 'trivial_evidence'
  | 'context_only_low'
  | 'deleted_code_only'
  | 'invalid_fields'
  | 'over_limit'
  /** Runtime-impact claim whose evidence is only in a test entry file (no exports). */
  | 'runtime_claim_on_test_code';

export const MAX_FINDINGS_PER_BATCH = 30;
const MAX_TITLE = 200;
const MAX_TEXT = 1_500;
const MAX_EVIDENCE = 800;
const MAX_EVIDENCE_LINES = 12;
const MAX_LINE_SPAN = 400;
/** Evidence that is itself defensive code (see GateNote `defensive_evidence`). */
export const DEFENSIVE_EVIDENCE_RE =
  /^\s*(?:if\s*\(\s*!|if\s*\(.*(?:===?\s*(?:null|undefined|false)\b|!==?))|\bthrow\b|\breject\s*\(|\bcatch\b|\.catch\s*\(|\b(?:logger|console)\.(?:warn|error|log|info|debug)\s*\(|\breport\w*Error\s*\(|\bset(?:Error|ErrorMessage)\s*\(|\?\?|\|\|\s*(?:['"`[{]|null|undefined|false|0|\w+\()|\?[^:?]+:\s*(?:null|undefined)\b|\breturn\s+(?:null|undefined|false)\b|status\(\s*40[134]\s*\)/;
/**
 * Choose among every match of the evidence (a moved or re-indented line exists as a deleted
 * and an added copy). The change classification decides: a removed-safeguard claim is about
 * the deleted copy; a claim about introduced behavior is about the added (surviving) copy; a
 * claim about existing code prefers the unchanged copy. Ties go to the copy nearest the
 * model's claimed line. Only when every match is deleted is the evidence deleted-only.
 */
export function selectEvidenceMatch(
  all: EvidenceMatch[][],
  changeType: ChangeType,
  claimedLine: number | null | undefined,
): { match: EvidenceMatch[] | null; moved: boolean } {
  if (all.length === 0) return { match: null, moved: false };
  const kinds = (m: EvidenceMatch[]) => {
    const sub = m.filter((x) => isSubstantiveCode(x.quoted));
    const lines = sub.length ? sub : m;
    return {
      del: lines.some((x) => x.line.kind === '-'),
      add: lines.some((x) => x.line.kind === '+'),
      allDel: lines.every((x) => x.line.kind === '-'),
    };
  };
  const preference = (m: EvidenceMatch[]): number => {
    const k = kinds(m);
    const surviving = !k.del;
    if (changeType === 'removed_safeguard') return k.del ? 0 : 1;
    if (changeType === 'introduced') {
      return surviving && k.add ? 0 : surviving ? 1 : !k.allDel ? 2 : 3;
    }
    // pre_existing / exposed_existing: about code that already existed at head.
    return surviving && !k.add ? 0 : surviving ? 1 : !k.allDel ? 2 : 3;
  };
  const distance = (m: EvidenceMatch[]) =>
    claimedLine == null || claimedLine <= 0
      ? 0
      : Math.min(
          ...m.map((x) =>
            Math.abs(
              ((x.line.kind === '-' ? x.line.oldLine : x.line.newLine) ?? 1e9) - claimedLine,
            ),
          ),
        );
  const ranked = all
    .map((m, i) => ({ m, i, p: preference(m), d: distance(m) }))
    .sort((a, b) => a.p - b.p || a.d - b.d || a.i - b.i);
  const moved = all.some((m) => kinds(m).allDel) && all.some((m) => !kinds(m).del && kinds(m).add);
  return { match: ranked[0]!.m, moved };
}

/** Lines a claimed range may extend beyond the evidence before it is narrowed to it. */
const RANGE_SLACK = 10;
/** Categories whose claims describe runtime behavior (as opposed to tests or style). */
export const RUNTIME_CATEGORIES: ReadonlySet<FindingCategory> = new Set<FindingCategory>([
  'security',
  'data_integrity',
  'availability',
  'correctness',
  'robustness',
]);
/** Minimum length for a trigger / failure path / impact to count as "stated". */
const MIN_TRIGGER = 12;
const MIN_FAILURE_PATH = 25;
const MIN_IMPACT = 12;

const SEVERITY_RANK: Record<PRReviewFindingSeverity, number> = { high: 3, medium: 2, low: 1 };
const CONFIDENCE_DOWN: Record<FindingConfidence, FindingConfidence> = {
  high: 'medium',
  medium: 'low',
  low: 'low',
};

export function minSeverity(
  a: PRReviewFindingSeverity,
  b: PRReviewFindingSeverity,
): PRReviewFindingSeverity {
  return SEVERITY_RANK[a] <= SEVERITY_RANK[b] ? a : b;
}

function normalizePath(raw: string): string {
  return raw
    .trim()
    .replace(/^`|`$/g, '')
    .replace(/^\.\//, '')
    .replace(/^[ab]\//, '')
    .replace(/^\/+/, '');
}

function clip(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

function clipEvidence(value: string): string {
  const lines = value.replace(/\r/g, '').split('\n');
  const kept = lines.slice(0, MAX_EVIDENCE_LINES).join('\n').trim();
  return clip(kept, MAX_EVIDENCE);
}

export type BatchValidation = {
  findings: ValidatedFinding[];
  rejectedByReason: Partial<Record<RejectionReason, number>>;
  /** Line references outside the reviewed hunks (recorded on each finding as claimedLines). */
  linesCorrected: number;
  /** Declared change types contradicted by the diff evidence and corrected. */
  changeTypeCorrections: number;
  /** Over-wide claimed ranges narrowed to the evidence. */
  rangesNarrowed: number;
};

/**
 * Keep only findings grounded in this batch's diff, and apply the deterministic severity
 * gates. Every adjustment is recorded on the finding (`gateNotes`, `claimedLines`,
 * `requestedSeverity`), never applied silently.
 *
 * Evidence rules:
 * - the path must be a file this batch reviewed (invented paths are rejected);
 * - the evidence must appear, in order, in the exact diff lines the batch was shown;
 * - at least one matched line must be substantive code (not `});`, `return`, braces);
 * - evidence must include a changed (`+`/`-`) line; evidence from unchanged hunk context is
 *   allowed only for MEDIUM/HIGH candidates, which then require independent verification.
 *
 * Severity gates (project memory cannot override them):
 * - severity is capped by category (only security / data integrity / availability can be HIGH;
 *   test gaps and maintainability are at most LOW);
 * - every MEDIUM/HIGH candidate requires independent verification;
 * - a HIGH without a stated trigger, failure path and impact is kept as a HIGH candidate (a
 *   real vulnerability is not downgraded for missing context) but can only be reported after
 *   verification confirms it; otherwise it lands in Needs Investigation.
 */
export function validateBatchFindings(
  output: BatchOutput,
  batch: PlannedBatch,
  /** Same text transform the prompt applied to the diff (so quoted evidence matches). */
  promptTransform: (text: string) => string = (t) => t,
): BatchValidation {
  const linesByPath = new Map<string, DiffLine[]>();
  // The prompt shows each path as `promptTransform` + delimiter neutralization rendered it
  // (F-20), so the model may cite that form. Both spellings resolve to the real path: a file
  // whose NAME contains prompt delimiters or control characters must not have every finding
  // on it rejected as "not in this batch" (that would be a way to exempt a file from review).
  const promptPathToPath = new Map<string, string>();
  for (const unit of batch.units) {
    const list = linesByPath.get(unit.path) ?? [];
    list.push(...unit.chunk.lines.map((line) => ({ ...line, text: promptTransform(line.text) })));
    linesByPath.set(unit.path, list);
    const shown = normalizePath(pathAsShownInPrompt(unit.path));
    if (shown !== unit.path && !promptPathToPath.has(shown)) promptPathToPath.set(shown, unit.path);
  }

  const rejectedByReason: Partial<Record<RejectionReason, number>> = {};
  const reject = (reason: RejectionReason) => {
    rejectedByReason[reason] = (rejectedByReason[reason] ?? 0) + 1;
  };
  const findings: ValidatedFinding[] = [];
  let linesCorrected = 0;
  let changeTypeCorrections = 0;
  let rangesNarrowed = 0;

  output.findings.forEach((raw, ordinal) => {
    if (findings.length >= MAX_FINDINGS_PER_BATCH) {
      reject('over_limit');
      return;
    }
    const cited = normalizePath(raw.path);
    const path = linesByPath.has(cited) ? cited : (promptPathToPath.get(cited) ?? cited);
    const lines = linesByPath.get(path);
    if (!lines) {
      reject('path_not_in_batch');
      return;
    }
    const title = clip(raw.title, MAX_TITLE);
    const explanation = clip(raw.explanation, MAX_TEXT);
    const evidence = clipEvidence(raw.evidence);
    if (
      !title ||
      !explanation ||
      !evidence ||
      !FINDING_CATEGORIES.includes(raw.category) ||
      !CHANGE_TYPES.includes(raw.changeType)
    ) {
      reject('invalid_fields');
      return;
    }
    const all = matchEvidenceAll(lines, evidence);
    if (all.length === 0) {
      reject('evidence_not_in_diff');
      return;
    }
    const selected = selectEvidenceMatch(all, raw.changeType, raw.lineStart);
    const matched = selected.match!;
    const moved = selected.moved;
    // Substance is judged on what was QUOTED: `});` is not evidence just because a real
    // line happens to contain it.
    const substantive = matched.filter((m) => isSubstantiveCode(m.quoted));
    if (substantive.length === 0) {
      reject('trivial_evidence');
      return;
    }

    const gateNotes: GateNote[] = [];
    let changeType: ChangeType = raw.changeType;
    if (moved) gateNotes.push('evidence_moved');

    // Deleted lines do not exist at the PR head. Evidence whose CHANGED lines are all deleted
    // can support exactly one kind of finding: a safeguard that was removed without
    // replacement. Unchanged context quoted next to them does not make it new code.
    const changed = substantive.filter((m) => m.line.kind !== ' ');
    const removedOnly = changed.length > 0 && changed.every((m) => m.line.kind === '-');
    if (removedOnly && changeType !== 'removed_safeguard') {
      const deletedGuard = changed.some(
        (m) => DEFENSIVE_EVIDENCE_RE.test(m.line.text) || /\bwhere\s*:/.test(m.line.text),
      );
      if (deletedGuard) {
        // The model mislabelled a removed check: the diff decides — judge it as removed.
        changeType = 'removed_safeguard';
        gateNotes.push('change_type_corrected');
      } else if (changed.length === substantive.length) {
        reject('deleted_code_only');
        return;
      }
    }
    if (changeType === 'removed_safeguard' && !substantive.some((m) => m.line.kind === '-')) {
      // Claims a removal but quotes no deleted line: judge it as a change to existing code.
      changeType = 'introduced';
      gateNotes.push('change_type_corrected');
    }
    if (changeType === 'pre_existing' && substantive.some((m) => m.line.kind === '+')) {
      // The diff decides, not the label: quoted ADDED code is new in this PR. A wrong
      // "pre-existing" label must not cap a new issue to LOW and skip verification.
      changeType = 'introduced';
      gateNotes.push('change_type_corrected');
    }
    if (gateNotes.includes('change_type_corrected')) changeTypeCorrections += 1;
    // A removed-safeguard claim quotes the deleted guard as its subject; that guard no longer
    // runs, so it is not defensive code the verifier must explain away.
    if (
      substantive.some(
        (m) =>
          !(changeType === 'removed_safeguard' && m.line.kind === '-') &&
          DEFENSIVE_EVIDENCE_RE.test(m.line.text),
      )
    ) {
      gateNotes.push('defensive_evidence');
    }

    // Changed vs context is decided by the substantive quoted lines only; context quoted next
    // to deleted lines of a claim that is not a removal describes existing code.
    const evidenceKind =
      changed.length > 0 && !(removedOnly && changeType !== 'removed_safeguard')
        ? 'changed'
        : 'context';
    const requestedCapped = minSeverity(raw.severity, CATEGORY_SEVERITY_CAP[raw.category]);
    if (
      evidenceKind === 'context' &&
      (changeType === 'introduced' || changeType === 'removed_safeguard') &&
      requestedCapped !== 'low'
    ) {
      // Quotes only unchanged code, so the PR did not introduce it. It may still be a serious
      // existing defect the PR exposes: keep its severity and let verification decide —
      // never silently downgrade it.
      changeType = 'exposed_existing';
      gateNotes.push('reclassified_exposed_existing');
    }

    let severity = minSeverity(raw.severity, CATEGORY_SEVERITY_CAP[raw.category]);
    if (severity !== raw.severity) gateNotes.push('category_cap');
    if (changeType === 'pre_existing' && severity !== 'low') {
      // Unrelated to the PR: noted, never a MEDIUM/HIGH PR finding. (A serious existing
      // defect the PR makes reachable is `exposed_existing` and keeps its severity.)
      severity = 'low';
      gateNotes.push('pre_existing_cap');
    }

    let confidence: FindingConfidence = raw.confidence;
    if (evidenceKind === 'context') {
      if (severity === 'low' && changeType !== 'pre_existing') {
        reject('context_only_low');
        return;
      }
      gateNotes.push('context_only_evidence');
      if (confidence === 'high') confidence = 'medium';
    }

    // Head anchor: the first non-deleted line at or after the evidence (deleted lines have
    // no head line number).
    const firstIdx = lines.indexOf(substantive[0]!.line);
    const headLine =
      lines.slice(Math.max(0, firstIdx)).find((l) => l.newLine != null)?.newLine ??
      [...lines.slice(0, Math.max(0, firstIdx))].reverse().find((l) => l.newLine != null)
        ?.newLine ??
      null;

    const located = evidenceRange(substantive.map((m) => m.line));
    let lineStart = located.start;
    let lineEnd = located.end;
    let claimedLines: ValidatedFinding['claimedLines'] = null;
    if (raw.lineStart != null && raw.lineStart > 0) {
      const start = Math.min(raw.lineStart, raw.lineEnd ?? raw.lineStart);
      const end = Math.max(raw.lineStart, raw.lineEnd ?? raw.lineStart);
      // The reported range must contain the matched evidence: a range that merely touches
      // the diff (e.g. a closing brace 13 lines below the quote) would point readers, the
      // verifier telemetry and the export at different code.
      const containsEvidence =
        located.start != null &&
        located.end != null &&
        start <= located.start &&
        end >= located.end &&
        end - start <= MAX_LINE_SPAN &&
        rangeTouchesLines(lines, start, end);
      const overlapsEvidence =
        located.start != null &&
        located.end != null &&
        start <= located.end &&
        end >= located.start;
      // A containing range much wider than the evidence (e.g. a whole 36-line file around a
      // one-line quote) is narrowed to the evidence; a tight range is kept.
      const evidenceSpan =
        located.start != null && located.end != null ? located.end - located.start : 0;
      if (containsEvidence && end - start <= evidenceSpan + RANGE_SLACK) {
        lineStart = start;
        lineEnd = end;
      } else if (containsEvidence) {
        gateNotes.push('line_range_narrowed');
        rangesNarrowed += 1;
      } else if (overlapsEvidence) {
        // Part of the evidence cited: anchor to the whole evidence, not a mismatch.
      } else {
        // Recorded, shown to the user, and treated as lower confidence — never silent.
        claimedLines = { start, end };
        gateNotes.push('line_mismatch');
        confidence = CONFIDENCE_DOWN[confidence];
        linesCorrected += 1;
      }
    }

    const trigger = clip(raw.trigger, MAX_TEXT);
    const failurePath = clip(raw.failurePath, MAX_TEXT);
    const impact = clip(raw.impact, MAX_TEXT);
    const supported =
      trigger.length >= MIN_TRIGGER &&
      failurePath.length >= MIN_FAILURE_PATH &&
      impact.length >= MIN_IMPACT;
    if (severity === 'high' && !supported) gateNotes.push('unsupported_failure_path');
    if (severity === 'medium' && trigger.length < MIN_TRIGGER) gateNotes.push('no_trigger');

    // Every MEDIUM/HIGH, and every removed-safeguard claim, needs independent verification.
    const needsVerification = severity !== 'low' || changeType === 'removed_safeguard';
    // LOW runtime claims are checked with spare verification capacity (after MEDIUM/HIGH);
    // when not confirmed they stay reported, labelled UNVERIFIED.
    const lowCheck = !needsVerification && RUNTIME_CATEGORIES.has(raw.category);
    findings.push({
      stableId: '',
      path,
      lineStart,
      lineEnd,
      claimedLines,
      category: raw.category,
      requestedSeverity: raw.severity,
      severity,
      confidence,
      title,
      explanation,
      evidence,
      evidenceKind,
      changeType,
      headLine,
      trigger,
      failurePath,
      violatedInvariant: clip(raw.violatedInvariant, MAX_TEXT),
      impact,
      assumptions: clip(raw.assumptions, MAX_TEXT),
      missingContext: clip(raw.missingContext, MAX_TEXT),
      gateNotes,
      verification:
        needsVerification || lowCheck ? { status: 'pending' } : { status: 'not_required' },
      // Until verified, MEDIUM/HIGH candidates are unresolved, not reported.
      disposition: needsVerification ? 'needs_investigation' : 'reported',
      alsoIn: [],
      batchId: batch.id,
      ordinal,
    });
  });

  return { findings, rejectedByReason, linesCorrected, changeTypeCorrections, rangesNarrowed };
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokens(text: string): Set<string> {
  return new Set(
    normalizeTitle(text)
      .split(' ')
      .filter((t) => t.length > 2),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

function firstEvidenceLine(evidence: string): string {
  const line = evidence
    .split('\n')
    .map((l) =>
      l
        .trim()
        .replace(/^[+-]\s?/, '')
        .replace(/\s+/g, ' '),
    )
    .find((l) => l.length >= 8);
  return line ?? '';
}

function rangesOverlap(a: ValidatedFinding, b: ValidatedFinding): boolean {
  if (a.lineStart == null || b.lineStart == null) return false;
  const aEnd = a.lineEnd ?? a.lineStart;
  const bEnd = b.lineEnd ?? b.lineStart;
  return a.lineStart <= bEnd + 2 && b.lineStart <= aEnd + 2;
}

/**
 * Two findings are one when they describe the same defect at the same place. A shared title
 * at distant lines, or a shared evidence line with a different kind of defect (an injection
 * and a missing authorization on one query), are distinct findings.
 */
function isSameFileDuplicate(a: ValidatedFinding, b: ValidatedFinding): boolean {
  if (a.path !== b.path) return false;
  const near = rangesOverlap(a, b) || a.lineStart == null || b.lineStart == null;
  if (normalizeTitle(a.title) === normalizeTitle(b.title) && near) return true;
  const ea = firstEvidenceLine(a.evidence);
  // Same line and kind is not enough: an injection and a missing authorization on one query
  // are two defects. The titles must describe the same defect too.
  if (
    ea &&
    ea === firstEvidenceLine(b.evidence) &&
    a.category === b.category &&
    jaccard(tokens(a.title), tokens(b.title)) >= 0.34
  ) {
    return true;
  }
  return rangesOverlap(a, b) && jaccard(tokens(a.title), tokens(b.title)) >= 0.5;
}

/**
 * Same root cause reported in another file (e.g. one batch per file each saying "workspace
 * isolation not verified"): same category and a near-identical invariant or title.
 */
/**
 * Same root cause in another file: same category, same change type, and a near-identical
 * title. A shared generic invariant ("only authorized users can …") is NOT enough on its
 * own — distinct defects must stay separate findings with their own evidence.
 */
function isSameRootCause(a: ValidatedFinding, b: ValidatedFinding): boolean {
  if (a.path === b.path || a.category !== b.category || a.changeType !== b.changeType) {
    return false;
  }
  const title = jaccard(tokens(a.title), tokens(b.title));
  if (title < 0.7) return false;
  const ai = tokens(a.violatedInvariant);
  const bi = tokens(b.violatedInvariant);
  return ai.size < 3 || bi.size < 3 || jaccard(ai, bi) >= 0.5;
}

/** Deterministic id: same file + anchor line + normalized title → same id across runs. */
export function stableFindingId(f: Pick<ValidatedFinding, 'path' | 'lineStart' | 'title'>): string {
  const digest = createHash('sha256')
    .update(`${f.path}\n${f.lineStart ?? ''}\n${normalizeTitle(f.title)}`)
    .digest('hex');
  return `prf_${digest.slice(0, 16)}`;
}

export function compareFindings(
  priorityByPath: Map<string, number>,
): (a: ValidatedFinding, b: ValidatedFinding) => number {
  return (a, b) =>
    SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
    (priorityByPath.get(b.path) ?? 0) - (priorityByPath.get(a.path) ?? 0) ||
    (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) ||
    (a.lineStart ?? 0) - (b.lineStart ?? 0) ||
    a.stableId.localeCompare(b.stableId);
}

/**
 * Merge findings from all batches BEFORE verification: drop same-file duplicates (keeping
 * the highest severity), assign stable ids and order deterministically. Occurrences of the
 * same root cause in different files are deliberately NOT merged here: each must be verified
 * on its own code, otherwise refuting one file would silently drop the others and confirming
 * one would wrongly present the others as confirmed. See {@link groupSameRootCause}.
 */
export function mergeFindings(
  findings: ValidatedFinding[],
  priorityByPath: Map<string, number>,
  batchOrder: string[],
): { findings: ValidatedFinding[]; duplicates: number } {
  const batchIndex = new Map(batchOrder.map((id, i) => [id, i]));
  const ordered = [...findings].sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      (priorityByPath.get(b.path) ?? 0) - (priorityByPath.get(a.path) ?? 0) ||
      (batchIndex.get(a.batchId) ?? 0) - (batchIndex.get(b.batchId) ?? 0) ||
      a.ordinal - b.ordinal,
  );
  const kept: ValidatedFinding[] = [];
  let duplicates = 0;
  for (const finding of ordered) {
    if (kept.some((k) => isSameFileDuplicate(k, finding))) {
      duplicates += 1;
      continue;
    }
    kept.push({ ...finding, alsoIn: [...finding.alsoIn] });
  }
  const withIds = kept.map((f) => ({ ...f, stableId: stableFindingId(f) }));
  withIds.sort(compareFindings(priorityByPath));
  return { findings: withIds, duplicates };
}

/**
 * Verification order: by severity and file priority, but within a severity the first
 * occurrence of each root cause goes before its repeats, so a pattern repeated in many files
 * cannot use up the verification budget ahead of distinct issues.
 */
export function verificationOrder(
  findings: ValidatedFinding[],
  priorityByPath: Map<string, number>,
): ValidatedFinding[] {
  const sorted = [...findings].sort(compareFindings(priorityByPath));
  const firsts: ValidatedFinding[] = [];
  const repeats: ValidatedFinding[] = [];
  for (const f of sorted) {
    (firsts.some((x) => isSameRootCause(x, f)) ? repeats : firsts).push(f);
  }
  return [...firsts, ...repeats].sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity],
  );
}

/**
 * AFTER verification: fold the same root cause across files into one entry with `alsoIn`,
 * but only among findings with the same disposition, verification status and severity — so
 * "Also in" files carry exactly the same verified status as the finding they are listed under.
 */
export function groupSameRootCause(
  findings: ValidatedFinding[],
  priorityByPath: Map<string, number>,
): { findings: ValidatedFinding[]; crossFileMerged: number } {
  const kept: ValidatedFinding[] = [];
  let crossFileMerged = 0;
  for (const finding of [...findings].sort(compareFindings(priorityByPath))) {
    const root = kept.find(
      (k) =>
        k.disposition === finding.disposition &&
        k.verification.status === finding.verification.status &&
        k.severity === finding.severity &&
        isSameRootCause(k, finding),
    );
    if (root) {
      if (!root.alsoIn.includes(finding.path)) root.alsoIn.push(finding.path);
      crossFileMerged += 1;
      continue;
    }
    kept.push({ ...finding, alsoIn: [...finding.alsoIn] });
  }
  return { findings: kept.sort(compareFindings(priorityByPath)), crossFileMerged };
}

/** Apply an independent verification verdict (the verifier may lower, never raise, severity). */
/** A pending check on an already-reported (LOW) finding is optional: it can only confirm or dismiss. */
export function isOptionalCheck(finding: ValidatedFinding): boolean {
  return finding.verification.status === 'pending' && finding.disposition === 'reported';
}

export function applyVerification(
  finding: ValidatedFinding,
  result:
    | { verdict: 'confirmed'; severity: PRReviewFindingSeverity; reason: string }
    | { verdict: 'refuted'; reason: string }
    | { verdict: 'insufficient_context'; reason: string }
    | { verdict: 'unavailable'; reason: string },
): ValidatedFinding {
  switch (result.verdict) {
    case 'confirmed': {
      const severity = minSeverity(finding.severity, result.severity);
      return {
        ...finding,
        severity,
        gateNotes:
          severity !== finding.severity
            ? [...finding.gateNotes, 'verifier_lowered_severity']
            : finding.gateNotes,
        verification: { status: 'confirmed', reason: result.reason },
        disposition: 'reported',
      };
    }
    case 'refuted':
      return {
        ...finding,
        verification: { status: 'refuted', reason: result.reason },
        disposition: 'dismissed',
      };
    default:
      // A LOW finding that could not be confirmed stays reported, explicitly UNVERIFIED;
      // a MEDIUM/HIGH one becomes Needs Investigation.
      if (isOptionalCheck(finding)) {
        return {
          ...finding,
          verification: { status: 'unverified', reason: result.reason },
          disposition: 'reported',
        };
      }
      return {
        ...finding,
        verification: {
          status:
            result.verdict === 'insufficient_context' ? 'insufficient_context' : 'unavailable',
          reason: result.reason,
        },
        disposition: 'needs_investigation',
      };
  }
}

/**
 * Overall risk from findings and coverage:
 * - a reported (verified) HIGH is always HIGH;
 * - an unresolved MEDIUM/HIGH candidate (Needs Investigation) or incomplete coverage means
 *   the risk is unknown — never LOW or MEDIUM;
 * - otherwise MEDIUM or LOW from reported findings.
 */
export function computeRiskLevel(
  findings: Pick<ValidatedFinding, 'severity' | 'disposition'>[],
  coverageComplete: boolean,
): PRReviewRiskLevel {
  const reported = findings.filter((f) => f.disposition === 'reported');
  const unresolved = findings.filter(
    (f) => f.disposition === 'needs_investigation' && f.severity !== 'low',
  );
  if (reported.some((f) => f.severity === 'high')) return 'high';
  if (unresolved.length > 0 || !coverageComplete) return 'unknown';
  if (reported.some((f) => f.severity === 'medium')) return 'medium';
  return 'low';
}
