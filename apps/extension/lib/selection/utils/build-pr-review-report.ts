import type {
  PageContext,
  PRReviewFinding,
  PRReviewFindingSeverity,
  PRReviewReport,
  PRReviewReportStats,
  PRReviewRiskLevel,
} from '@project-x/types';

import { parsePrReviewContent, type ParsedPrFinding } from './parse-pr-review';

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
  truncated: boolean,
): PRReviewReportStats {
  const high = findings.filter((finding) => finding.severity === 'high').length;
  const medium = findings.filter((finding) => finding.severity === 'medium').length;
  const low = findings.filter((finding) => finding.severity === 'low').length;

  return {
    analyzedFiles,
    skippedFiles: truncated ? 1 : 0,
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
};

/**
 * Build a Day 10 PRReviewReport from Day 9 stream markdown + page context.
 */
export function buildPrReviewReport(input: BuildPrReviewReportInput): PRReviewReport | null {
  const parsed = parsePrReviewContent(input.markdown);
  if (!parsed.structured && parsed.findings.length === 0 && !parsed.summary.trim()) {
    return null;
  }

  const github = input.context?.type === 'github' ? input.context.github : undefined;
  const findings = parsed.findings.map(toSharedFinding);
  const analyzedFiles = github?.changedFiles?.length ?? 0;
  const truncated = Boolean(github?.changedFilesTruncated);

  const owner = github?.owner?.trim() || 'unknown';
  const name = github?.repository?.trim() || 'unknown';
  const number =
    github?.pullRequestNumber && github.pullRequestNumber > 0 ? github.pullRequestNumber : 0;

  return {
    repository: { owner, name },
    pullRequest: {
      number,
      title: github?.pullRequestTitle?.trim() || undefined,
    },
    riskLevel: deriveRiskLevel(findings),
    overview: parsed.summary.trim() || 'No overview provided.',
    stats: buildStats(findings, analyzedFiles, truncated),
    findings,
    reviewScope: {
      truncated,
      partialFailureCount: 0,
    },
  };
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
