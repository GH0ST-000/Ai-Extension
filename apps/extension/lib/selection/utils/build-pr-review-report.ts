import type {
  PageContext,
  PageContextGitHub,
  PRReviewFinding,
  PRReviewFindingSeverity,
  PRReviewReport,
  PRReviewReportStats,
  PRReviewRiskLevel,
  PRReviewScope,
} from '@project-x/types';

import { parsePrReviewContent, type ParsedPrFinding, type ParsedPrReview } from './parse-pr-review';

export function prFindingId(
  finding: Pick<ParsedPrFinding, 'index' | 'filePath' | 'title'>,
): string {
  return `${finding.index}:${finding.filePath ?? ''}:${finding.title}`;
}

function toSharedSeverity(severity: ParsedPrFinding['severity']): PRReviewFindingSeverity {
  if (severity === 'high' || severity === 'medium' || severity === 'low') {
    return severity;
  }
  return 'medium';
}

function toSharedFinding(finding: ParsedPrFinding): PRReviewFinding {
  return {
    id: prFindingId(finding),
    index: finding.index,
    severity: toSharedSeverity(finding.severity),
    filePath: finding.filePath ?? undefined,
    title: finding.title,
    why: finding.why,
    raw: finding.raw,
  };
}

function deriveRiskLevel(findings: PRReviewFinding[]): PRReviewRiskLevel {
  if (findings.some((finding) => finding.severity === 'high')) {
    return 'high';
  }
  if (findings.some((finding) => finding.severity === 'medium')) {
    return 'medium';
  }
  return 'low';
}

function buildStats(
  findings: PRReviewFinding[],
  analyzedFiles: number,
  skippedFiles: number,
): PRReviewReportStats {
  const high = findings.filter((finding) => finding.severity === 'high').length;
  const medium = findings.filter((finding) => finding.severity === 'medium').length;
  const low = findings.filter((finding) => finding.severity === 'low').length;

  return {
    analyzedFiles,
    skippedFiles,
    findings: findings.length,
    critical: 0,
    high,
    medium,
    low,
    suggestions: low,
  };
}

export type BuildPrReviewReportInput = {
  markdown: string;
  context?: PageContext | null;
  /** Scope the API reported for this run; authoritative over the page context. */
  scope?: PRReviewScope | null;
  /**
   * True once the stream has finished. Completeness is only judged on final output so a
   * review that is still streaming is not flagged as incomplete.
   */
  final?: boolean;
};

const INCOMPLETE_REASON_TEXT: Record<string, string> = {
  length: 'The model hit its output limit before finishing the review.',
  error: 'The AI provider stopped with an error before finishing the review.',
  'content-filter': 'The AI provider filtered the response before it finished.',
};

function resolveScope(
  scope: PRReviewScope | null | undefined,
  github: PageContextGitHub | undefined,
): {
  analyzed: number;
  skipped: number;
  total: number | null;
  truncated: boolean;
  source?: PRReviewScope['source'];
} {
  if (scope) {
    return {
      analyzed: scope.analyzedFiles,
      skipped: scope.skippedFiles,
      total: scope.totalFiles,
      truncated: scope.truncated,
      source: scope.source,
    };
  }
  // Legacy servers without the scope header: count only files whose diff was captured.
  const files = github?.changedFiles ?? [];
  const analyzed = files.filter((file) => file.patchExcerpt?.trim()).length;
  return {
    analyzed,
    skipped: files.length - analyzed,
    total: null,
    truncated: Boolean(github?.changedFilesTruncated) && files.length > 0,
    ...(files.length > 0 ? { source: 'page' as const } : {}),
  };
}

function assessCompleteness(
  parsed: ParsedPrReview,
  analyzedFiles: number,
): { complete: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (parsed.incompleteReason) {
    reasons.push(
      INCOMPLETE_REASON_TEXT[parsed.incompleteReason] ??
        'The review stream ended before the model finished.',
    );
  }
  if (analyzedFiles === 0) {
    reasons.push('No file diffs were reviewed.');
  }
  if (!parsed.hasFindingsSection) {
    reasons.push('The response has no "Risk Findings" section.');
  } else if (parsed.findings.length === 0 && !parsed.explicitNoRisks) {
    reasons.push('The Risk Findings section lists no findings and does not state "no risks".');
  }
  if (parsed.unparsedFindingCount > 0) {
    reasons.push(
      `${parsed.unparsedFindingCount} finding${parsed.unparsedFindingCount === 1 ? '' : 's'} could not be parsed (unexpected format).`,
    );
  }
  return { complete: reasons.length === 0, reasons };
}

/**
 * Build a Day 10 PRReviewReport from Day 9 stream markdown + page context.
 * Any non-empty output yields a report, but `completeness.complete` is only true for a
 * well-formed review of at least one file diff — never for a cut-off or generic answer.
 */
export function buildPrReviewReport(input: BuildPrReviewReportInput): PRReviewReport | null {
  const parsed = parsePrReviewContent(input.markdown);
  if (!parsed.structured && parsed.findings.length === 0 && !parsed.summary.trim()) {
    return null;
  }

  const github = input.context?.type === 'github' ? input.context.github : undefined;
  const findings = parsed.findings.map(toSharedFinding);
  const scope = resolveScope(input.scope, github);
  const analyzedFiles = scope.analyzed;
  const truncated = scope.truncated;

  const owner = github?.owner?.trim() || 'unknown';
  const name = github?.repository?.trim() || 'unknown';
  const number =
    github?.pullRequestNumber && github.pullRequestNumber > 0 ? github.pullRequestNumber : 0;
  const completeness = input.final ? assessCompleteness(parsed, analyzedFiles) : undefined;

  return {
    repository: { owner, name },
    pullRequest: {
      number,
      title: github?.pullRequestTitle?.trim() || undefined,
    },
    riskLevel: resolveRiskLevel(findings, completeness?.complete === true),
    overview: parsed.summary.trim() || 'No overview provided.',
    stats: buildStats(findings, analyzedFiles, scope.skipped),
    findings,
    reviewScope: {
      truncated,
      partialFailureCount: 0,
      totalFiles: scope.total,
      ...(scope.source ? { source: scope.source } : {}),
    },
    ...(completeness ? { completeness } : {}),
  };
}

/**
 * Overall risk is only derived from a finished, complete review. An incomplete or still-
 * streaming review is never LOW or MEDIUM: a HIGH finding already seen is a safe lower
 * bound, otherwise the risk is `unknown`.
 */
function resolveRiskLevel(findings: PRReviewFinding[], complete: boolean): PRReviewRiskLevel {
  if (complete) {
    return deriveRiskLevel(findings);
  }
  return findings.some((finding) => finding.severity === 'high') ? 'high' : 'unknown';
}

/** "3 findings", or for an incomplete review "findings unknown" / "2+ findings (partial)". */
export function formatFindingsCountLabel(report: PRReviewReport): string {
  const n = report.stats.findings;
  if (report.completeness?.complete === false) {
    return n === 0 ? 'findings unknown' : `${n}+ finding${n === 1 ? '' : 's'} (partial)`;
  }
  return `${n} finding${n === 1 ? '' : 's'}`;
}

/** "3 of 12 files" / "3 files" / "0 files" for headers and exports. */
export function formatReviewedFilesLabel(report: PRReviewReport): string {
  const total = report.reviewScope?.totalFiles;
  const analyzed = report.stats.analyzedFiles;
  if (typeof total === 'number' && total !== analyzed) {
    return `${analyzed} of ${total} files reviewed`;
  }
  return `${analyzed} file${analyzed === 1 ? '' : 's'} reviewed`;
}

export type PrFindingFilter = 'all' | 'high' | 'medium' | 'low' | 'open' | 'reviewed' | 'ignored';

export type PrFindingDisposition = 'reviewed' | 'ignored';

export type PrFindingDispositionMap = Readonly<Record<string, PrFindingDisposition>>;

export function filterPrFindings(
  findings: PRReviewFinding[],
  filter: PrFindingFilter,
  dispositions: PrFindingDispositionMap | ReadonlySet<string> = {},
): PRReviewFinding[] {
  const map: PrFindingDispositionMap =
    dispositions instanceof Set
      ? Object.fromEntries([...dispositions].map((id) => [id, 'reviewed' as const]))
      : dispositions;

  return findings.filter((finding) => {
    const status = map[finding.id];
    if (filter === 'open') {
      return !status;
    }
    if (filter === 'reviewed') {
      return status === 'reviewed';
    }
    if (filter === 'ignored') {
      return status === 'ignored';
    }
    if (filter === 'all') {
      return true;
    }
    return finding.severity === filter;
  });
}
