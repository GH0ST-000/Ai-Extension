import { PR_REVIEW_INCOMPLETE_MARKER } from '@project-x/types';

export type PrRiskSeverity = 'high' | 'medium' | 'low' | 'unknown';

export type ParsedPrFinding = {
  index: number;
  severity: PrRiskSeverity;
  filePath: string | null;
  title: string;
  why: string;
  /** Full finding block for follow-up prompts. */
  raw: string;
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
};

// Severity tag forms seen from models: **[high]**, [HIGH], **high**, (high), **[High]**:
const SEVERITY_TAG = String.raw`(?:\*\*\s*)?[\[(]?\s*(high|medium|med|low)\s*[\])]?(?:\s*\*\*)?\s*:?`;
const FINDING_RE = new RegExp(
  String.raw`^(\d+)[.)]\s*${SEVERITY_TAG}\s*(?:\x60([^\x60]+)\x60\s*(?:[—–:-]\s*)?)?(.+?)\s*$`,
  'i',
);

const SUMMARY_HEADING_RE = /^#{2,3}\s*\**\s*Summary\b.*$/im;
const FINDINGS_HEADING_RE = /^#{2,3}\s*\**\s*(?:Risk\s+)?Findings\b.*$/im;
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

/**
 * Parse REVIEW_ENTIRE_PR markdown into summary + numbered risk findings, recording enough
 * structure for the caller to tell a real "no findings" review from an incomplete one.
 */
export function parsePrReviewContent(content: string): ParsedPrReview {
  const { text, incompleteReason } = stripIncompleteMarker(content);
  const trimmed = text.trim();
  const empty: ParsedPrReview = {
    summary: '',
    findings: [],
    structured: false,
    hasFindingsSection: false,
    unparsedFindingCount: 0,
    explicitNoRisks: false,
    incompleteReason,
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

  const findingsBody = findingsHeading
    ? trimmed.slice(findingsHeading.index + findingsHeading[0].length).trim()
    : '';
  const findings: ParsedPrFinding[] = [];
  let unparsedFindingCount = 0;

  if (findingsBody) {
    const blocks = findingsBody
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
        unparsedFindingCount += 1;
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
      });
    }
  }

  return {
    summary,
    findings,
    structured: true,
    hasFindingsSection: Boolean(findingsHeading),
    unparsedFindingCount,
    explicitNoRisks: findings.length === 0 && NO_RISKS_RE.test(findingsBody),
    incompleteReason,
  };
}
