import { PR_REVIEW_INCOMPLETE_MARKER, type PRReviewCoverage } from '@project-x/types';

import { stripPrReviewTrailers } from './pr-review-coverage';

export type PrRiskSeverity = 'high' | 'medium' | 'low' | 'unknown';

export type ParsedPrFinding = {
  index: number;
  severity: PrRiskSeverity;
  filePath: string | null;
  title: string;
  why: string;
  /** Full finding block for follow-up prompts. */
  raw: string;
  /** Server stable id (`Ref: prf_…`), when the API provided one. */
  ref?: string;
  lineStart?: number;
  lineEnd?: number;
  /** Validated diff evidence (`Evidence:` block), when provided. */
  evidence?: string;
  category?: string;
  confidence?: 'high' | 'medium' | 'low';
  verification?: string;
  trigger?: string;
  failurePath?: string;
  impact?: string;
  alsoIn?: string[];
  changeType?: string;
};

export type ParsedPrReview = {
  summary: string;
  findings: ParsedPrFinding[];
  /** True when structured sections were detected. */
  structured: boolean;
  /** True when a "Risk Findings" heading is present. */
  hasFindingsSection: boolean;
  /** Numbered items under Risk Findings whose header could not be parsed. */
  unparsedFindingCount: number;
  /** The model explicitly stated there are no material risks. */
  explicitNoRisks: boolean;
  /** Set when the API marked the stream as ended early (e.g. `length`, `error`). */
  incompleteReason: string | null;
  /** Server coverage manifest from the response trailer (batched reviews). */
  coverage: PRReviewCoverage | null;
  /** "## Needs Investigation": unresolved MEDIUM/HIGH candidates (not findings). */
  investigation: ParsedPrFinding[];
};

// Severity tag forms seen from models: **[high]**, [HIGH], **high**, (high), **[High]**:
const SEVERITY_TAG = String.raw`(?:\*\*\s*)?[\[(]?\s*(high|medium|med|low)\s*[\])]?(?:\s*\*\*)?\s*:?`;
const FINDING_RE = new RegExp(
  String.raw`^(\d+)[.)]\s*${SEVERITY_TAG}\s*(?:\x60([^\x60]+)\x60\s*(?:[—–:-]\s*)?)?(.+?)\s*$`,
  'i',
);

const SUMMARY_HEADING_RE = /^#{2,3}\s*\**\s*Summary\b.*$/im;
const FINDINGS_HEADING_RE = /^#{2,3}\s*\**\s*(?:Risk\s+)?Findings\b.*$/im;
const INVESTIGATION_HEADING_RE = /^#{2,3}\s*\**\s*Needs\s+Investigation\b.*$/im;
/** Section boundaries only — sub-headings inside a legacy findings list must not cut it. */
const SECTION_HEADING_RE =
  /^#{2,3}\s*\**\s*(?:Needs\s+Investigation|Summary|(?:Risk\s+)?Findings)\b.*$/gim;
const NO_RISKS_RE =
  /\bno\s+(?:material\s+|significant\s+|notable\s+)?(?:risks?|issues?|findings?)\b/i;
const INCOMPLETE_MARKER_RE = new RegExp(
  String.raw`\s*${PR_REVIEW_INCOMPLETE_MARKER.replace(/[[\]]/g, '\\$&')}\s+reason=([a-z-]+)\]\]\s*$`,
  'i',
);

function normalizeSeverity(value: string): PrRiskSeverity {
  const lower = value.toLowerCase();
  if (lower === 'high' || lower === 'medium' || lower === 'low') {
    return lower;
  }
  if (lower === 'med') {
    return 'medium';
  }
  return 'unknown';
}

/** Remove the API's incomplete-stream trailer; returns the clean text and the reason. */
export function stripIncompleteMarker(content: string): {
  text: string;
  incompleteReason: string | null;
} {
  const match = INCOMPLETE_MARKER_RE.exec(content);
  if (!match) {
    return { text: content, incompleteReason: null };
  }
  return { text: content.slice(0, match.index), incompleteReason: match[1]!.toLowerCase() };
}

const REF_RE = /^ref:\s*(prf_[0-9a-f]{16})\s*$/i;
const LINES_RE = /^lines:\s*L(\d+)(?:\s*-\s*L?(\d+))?\s*$/i;

type StructuredFields = Pick<
  ParsedPrFinding,
  | 'ref'
  | 'lineStart'
  | 'lineEnd'
  | 'evidence'
  | 'category'
  | 'confidence'
  | 'verification'
  | 'trigger'
  | 'failurePath'
  | 'impact'
  | 'alsoIn'
  | 'changeType'
>;

const LABELLED: { re: RegExp; key: 'verification' | 'trigger' | 'failurePath' | 'impact' }[] = [
  { re: /^verification:\s*(.+)$/i, key: 'verification' },
  { re: /^trigger:\s*(.+)$/i, key: 'trigger' },
  { re: /^failure path:\s*(.+)$/i, key: 'failurePath' },
  { re: /^impact:\s*(.+)$/i, key: 'impact' },
];

/** Optional structured fields the batched API adds under each finding. */
function structuredFields(rawLines: string[]): StructuredFields {
  const out: StructuredFields = {};
  const evidence: string[] = [];
  let inEvidence = false;
  for (const rawLine of rawLines) {
    const line = rawLine.trim();
    if (inEvidence) {
      if (line.startsWith('│')) {
        evidence.push(line.replace(/^│ ?/, ''));
        continue;
      }
      inEvidence = false;
    }
    const ref = REF_RE.exec(line);
    if (ref) out.ref = ref[1]!.toLowerCase();
    const lines = LINES_RE.exec(line.replace(/\s*\(model cited.*\)\s*$/i, ''));
    if (lines) {
      out.lineStart = Number(lines[1]);
      out.lineEnd = Number(lines[2] ?? lines[1]);
    }
    const cat = /^category:\s*([a-z_]+)\s*·\s*confidence:\s*(high|medium|low)\s*$/i.exec(line);
    if (cat) {
      out.category = cat[1]!.toLowerCase();
      out.confidence = cat[2]!.toLowerCase() as 'high' | 'medium' | 'low';
    }
    for (const { re, key } of LABELLED) {
      const m = re.exec(line);
      if (m) out[key] = m[1]!.trim().slice(0, 1_500);
    }
    const change = /^change:\s*(.+)$/i.exec(line);
    if (change) {
      const label = change[1]!.toLowerCase();
      out.changeType = label.startsWith('safeguard removed')
        ? 'removed_safeguard'
        : label.startsWith('existing defect exposed')
          ? 'exposed_existing'
          : label.startsWith('pre-existing')
            ? 'pre_existing'
            : label.startsWith('introduced')
              ? 'introduced'
              : undefined;
      if (!out.changeType) delete out.changeType;
    }
    const also = /^also in:\s*(.+)$/i.exec(line);
    if (also) {
      out.alsoIn = [...also[1]!.matchAll(/`([^`]+)`/g)].map((x) => x[1]!).slice(0, 50);
    }
    if (/^evidence:\s*$/i.test(line)) inEvidence = true;
  }
  if (evidence.length > 0) out.evidence = evidence.join('\n');
  return out;
}

/** Text of a section: from after its heading to the next known section heading. */
function sectionBody(text: string, heading: RegExpExecArray | null): string {
  if (!heading) return '';
  const start = heading.index + heading[0].length;
  SECTION_HEADING_RE.lastIndex = start;
  const next = SECTION_HEADING_RE.exec(text);
  return text.slice(start, next ? next.index : text.length).trim();
}

function parseFindingBlocks(body: string): { findings: ParsedPrFinding[]; unparsed: number } {
  const findings: ParsedPrFinding[] = [];
  let unparsed = 0;
  if (!body) return { findings, unparsed };
  const blocks = body
    .split(/(?=^\s*\d+[.)]\s)/m)
    .map((block) => block.trim())
    .filter(Boolean);

  for (const block of blocks) {
    const lines = block
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const header = lines[0] ?? '';
    if (!/^\d+[.)]\s/.test(header)) {
      continue; // prose before the list, e.g. "No material risks found."
    }
    // The severity must be marked up (**, [ or ( ) so "1. Low coverage" is not a "low".
    const match = /^\d+[.)]\s*(?:\*\*|\[|\()/.test(header) ? FINDING_RE.exec(header) : null;
    if (!match) {
      unparsed += 1;
      continue;
    }

    const whyLine = lines.find((line) => /^\**why\**:/i.test(line));
    const why = whyLine
      ? whyLine.replace(/^\**why\**:\s*/i, '').trim()
      : lines.slice(1).join(' ').trim();

    findings.push({
      index: Number.parseInt(match[1] ?? '0', 10),
      severity: normalizeSeverity(match[2] ?? ''),
      filePath: match[3]?.trim() || null,
      title: (match[4] ?? '').replace(/^[—–:-]\s*/, '').trim(),
      why,
      raw: block,
      ...structuredFields(block.split('\n')),
    });
  }
  return { findings, unparsed };
}

/**
 * Parse REVIEW_ENTIRE_PR markdown into summary + numbered risk findings, recording enough
 * structure for the caller to tell a real "no findings" review from an incomplete one.
 */
export function parsePrReviewContent(content: string): ParsedPrReview {
  const { text, incompleteReason, coverage } = stripPrReviewTrailers(content);
  const trimmed = text.trim();
  const empty: ParsedPrReview = {
    summary: '',
    findings: [],
    structured: false,
    hasFindingsSection: false,
    unparsedFindingCount: 0,
    explicitNoRisks: false,
    incompleteReason,
    coverage,
    investigation: [],
  };
  if (!trimmed) {
    return empty;
  }

  const summaryHeading = SUMMARY_HEADING_RE.exec(trimmed);
  const findingsHeading = FINDINGS_HEADING_RE.exec(trimmed);

  if (!summaryHeading && !findingsHeading) {
    return { ...empty, summary: trimmed };
  }

  let summary = '';
  if (summaryHeading) {
    const start = summaryHeading.index + summaryHeading[0].length;
    const end =
      findingsHeading && findingsHeading.index > summaryHeading.index
        ? findingsHeading.index
        : trimmed.length;
    summary = trimmed.slice(start, end).trim();
  }

  const findingsBody = sectionBody(trimmed, findingsHeading);
  const { findings, unparsed: unparsedFindingCount } = parseFindingBlocks(findingsBody);
  const investigation = parseFindingBlocks(
    sectionBody(trimmed, INVESTIGATION_HEADING_RE.exec(trimmed)),
  ).findings;

  return {
    summary,
    findings,
    structured: true,
    hasFindingsSection: Boolean(findingsHeading),
    unparsedFindingCount,
    explicitNoRisks: findings.length === 0 && NO_RISKS_RE.test(findingsBody),
    incompleteReason,
    coverage,
    investigation,
  };
}
