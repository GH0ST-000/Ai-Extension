import type {
  ProjectMemoryPromptMetadata,
  PRReviewFinding,
  PRReviewReport,
} from '@project-x/types';

import { formatFindingsCountLabel, formatReviewedFilesLabel } from './build-pr-review-report';
import { memoryExportSection, memorySummaryLine } from './project-memory-metadata';
import {
  coverageGaps,
  excludedCount,
  isUnverifiedPageScope,
  PAGE_FALLBACK_NOTICE,
  unreviewedFiles,
} from './pr-review-coverage';

const MAX_EXPORTED_UNREVIEWED = 100;

/** "## Coverage" section lines for exports (empty for legacy reviews without a manifest). */
export function formatCoverageSection(report: PRReviewReport): string[] {
  const coverage = report.coverage;
  const pageFallback = isUnverifiedPageScope(report.reviewScope);
  if (!coverage) {
    // Legacy / scope-only reviews: still state that coverage could not be verified.
    return pageFallback ? ['## Coverage', `**Unverified coverage** — ${PAGE_FALLBACK_NOTICE}`] : [];
  }
  const c = coverage.counts;
  const total = coverage.totalFiles ?? coverage.files.length + c.not_fetched;
  const ofTotal = pageFallback
    ? `${total} file${total === 1 ? '' : 's'} found on the GitHub page`
    : `${total} changed files`;
  const lines = ['## Coverage'];
  if (pageFallback) lines.push(`**Unverified coverage** — ${PAGE_FALLBACK_NOTICE}`);
  lines.push(
    coverage.complete && !pageFallback
      ? `Full coverage: all ${c.reviewed_full} reviewable files of ${total} changed files were reviewed.`
      : `**Partial coverage** — ${c.reviewed_full} of ${ofTotal} fully reviewed. Risk is not rated LOW while code is unreviewed.`,
  );
  for (const gap of coverageGaps(coverage)) lines.push(`- ${gap.count} ${gap.label}`);
  const failed = coverage.batches.filter((b) => b.status !== 'succeeded').length;
  if (failed) lines.push(`- ${failed} of ${coverage.batches.length} AI batches failed`);
  const excluded = excludedCount(coverage);
  if (excluded)
    lines.push(`- ${excluded} generated, binary or rename-only files excluded on purpose`);
  const files = unreviewedFiles(coverage);
  if (files.length > 0) {
    lines.push('', 'Not fully reviewed:');
    for (const file of files.slice(0, MAX_EXPORTED_UNREVIEWED)) {
      lines.push(`- \`${file.path}\` (${file.status.replace(/_/g, ' ')})`);
    }
    if (files.length > MAX_EXPORTED_UNREVIEWED) {
      lines.push(`- … and ${files.length - MAX_EXPORTED_UNREVIEWED} more`);
    }
  }
  return lines;
}

function riskLabel(report: PRReviewReport): string {
  return report.completeness?.complete === false ? 'INCOMPLETE' : report.riskLevel.toUpperCase();
}

export type PrFindingDisposition = 'reviewed' | 'ignored';

export type PrFindingDispositionMap = Readonly<Record<string, PrFindingDisposition>>;

export type FormatPrReviewMarkdownOptions = {
  /** Session-only finding dispositions. */
  dispositions?: PrFindingDispositionMap;
  /** Project Memory outcome reported by the API for this review (status and counts only). */
  memory?: ProjectMemoryPromptMetadata | null;
  /**
   * @deprecated Prefer `dispositions`. Treated as `reviewed`.
   */
  resolvedIds?: ReadonlySet<string>;
  /** Include a short handoff blurb at the top. */
  includeHandoffSummary?: boolean;
};

function severityLabel(severity: PRReviewFinding['severity']): string {
  return severity.toUpperCase();
}

export function resolveDispositionMap(
  dispositions?: PrFindingDispositionMap,
  resolvedIds?: ReadonlySet<string>,
): PrFindingDispositionMap {
  if (dispositions && Object.keys(dispositions).length > 0) {
    return dispositions;
  }
  if (!resolvedIds || resolvedIds.size === 0) {
    return {};
  }
  const mapped: Record<string, PrFindingDisposition> = {};
  for (const id of resolvedIds) {
    mapped[id] = 'reviewed';
  }
  return mapped;
}

function statusLabel(
  findingId: string,
  dispositions: PrFindingDispositionMap,
): 'open' | 'reviewed' | 'ignored' {
  return dispositions[findingId] ?? 'open';
}

function formatFinding(finding: PRReviewFinding, dispositions: PrFindingDispositionMap): string {
  const status = statusLabel(finding.id, dispositions);
  const path = finding.filePath ? `\`${finding.filePath}\`` : '_unspecified file_';
  const why = finding.why ? `\n   Why: ${finding.why}` : '';
  const details = [
    finding.category || finding.confidence
      ? `\n   Category: ${finding.category ?? 'n/a'} · Confidence: ${finding.confidence ?? 'n/a'}`
      : '',
    finding.changeType ? `\n   Change: ${finding.changeType.replace(/_/g, ' ')}` : '',
    finding.verification ? `\n   Verification: ${finding.verification}` : '',
    finding.trigger ? `\n   Trigger: ${finding.trigger}` : '',
    finding.failurePath ? `\n   Failure path: ${finding.failurePath}` : '',
    finding.impact ? `\n   Impact: ${finding.impact}` : '',
    finding.alsoIn?.length
      ? `\n   Also in: ${finding.alsoIn.map((p) => `\`${p}\``).join(', ')}`
      : '',
  ].join('');
  const lines =
    finding.lineStart != null
      ? `\n   Lines: L${finding.lineStart}${finding.lineEnd != null && finding.lineEnd !== finding.lineStart ? `-L${finding.lineEnd}` : ''}`
      : '';
  const evidence = finding.evidence
    ? `\n   Evidence:\n${finding.evidence
        .split('\n')
        .map((line) => `   │ ${line}`)
        .join('\n')}`
    : '';
  return `${finding.index}. **[${severityLabel(finding.severity)}]** ${path} — ${finding.title} (${status})${why}${details}${lines}${evidence}`;
}

/**
 * Client-side review handoff summary (no extra model call).
 */
export function buildPrReviewHandoffSummary(
  report: PRReviewReport,
  dispositions: PrFindingDispositionMap = {},
  memory?: ProjectMemoryPromptMetadata | null,
): string {
  let open = 0;
  let reviewed = 0;
  let ignored = 0;
  for (const finding of report.findings) {
    const status = dispositions[finding.id];
    if (status === 'reviewed') {
      reviewed += 1;
    } else if (status === 'ignored') {
      ignored += 1;
    } else {
      open += 1;
    }
  }

  const prLabel = report.pullRequest.title
    ? `#${report.pullRequest.number} ${report.pullRequest.title}`
    : `#${report.pullRequest.number}`;

  return [
    `PR ${prLabel} in ${report.repository.owner}/${report.repository.name}`,
    `Overall risk: ${riskLabel(report)}`,
    `Findings: ${formatFindingsCountLabel(report)} · ${report.stats.high} high · ${report.stats.medium} medium · ${report.stats.low} low`,
    `Session: ${open} open · ${reviewed} reviewed · ${ignored} ignored`,
    `Files: ${formatReviewedFilesLabel(report)}${report.reviewScope?.truncated ? ' (partial coverage)' : ''}`,
    memorySummaryLine(memory),
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n');
}

/**
 * Export a complete markdown review artifact for Copy Full Review / Export Markdown.
 */
export function formatPrReviewMarkdown(
  report: PRReviewReport,
  options: FormatPrReviewMarkdownOptions = {},
): string {
  const dispositions = resolveDispositionMap(options.dispositions, options.resolvedIds);
  const parts: string[] = [];

  const prHeading = report.pullRequest.title
    ? `PR #${report.pullRequest.number}: ${report.pullRequest.title}`
    : `PR #${report.pullRequest.number}`;

  parts.push(`# Review Report — ${report.repository.owner}/${report.repository.name}`);
  parts.push('');
  parts.push(prHeading);
  parts.push(`Risk level: **${riskLabel(report)}**`);
  parts.push('');
  if (report.completeness?.complete === false) {
    parts.push('> **Incomplete review** — do not treat as a clean PR.');
    for (const reason of report.completeness.reasons) {
      parts.push(`> - ${reason}`);
    }
    parts.push('');
  }

  if (options.includeHandoffSummary !== false) {
    parts.push('## Handoff summary');
    parts.push(buildPrReviewHandoffSummary(report, dispositions, options.memory));
    parts.push('');
  }

  parts.push('## Overview');
  parts.push(report.overview);
  parts.push('');

  // The reviewer's own export: consumers were already authorized for them. Never included in
  // the GitHub comment draft (buildPrReviewCommentDraft) or review drafts.
  if (report.downstreamImpact) {
    parts.push('## Downstream Impact');
    parts.push(report.downstreamImpact);
    parts.push('');
  }

  parts.push('## Stats');
  parts.push(
    [
      `- Files: ${formatReviewedFilesLabel(report)}`,
      `- Findings: ${formatFindingsCountLabel(report)}`,
      `- High: ${report.stats.high}`,
      `- Medium: ${report.stats.medium}`,
      `- Low: ${report.stats.low}`,
      report.reviewScope?.truncated
        ? '- Scope: partial (not every file or line was reviewed)'
        : null,
    ]
      .filter(Boolean)
      .join('\n'),
  );
  parts.push('');

  const coverageSection = formatCoverageSection(report);
  if (coverageSection.length > 0) {
    parts.push(...coverageSection, '');
  }

  const memorySection = memoryExportSection(options.memory);
  if (memorySection.length > 0) {
    parts.push(...memorySection, '');
  }

  parts.push('## Risk Findings');
  if (report.findings.length === 0) {
    parts.push('_No material findings._');
  } else {
    for (const finding of report.findings) {
      parts.push(formatFinding(finding, dispositions));
    }
  }
  parts.push('');
  const investigate = report.needsInvestigation ?? [];
  if (investigate.length > 0) {
    parts.push('## Needs Investigation');
    parts.push(
      '_Unresolved candidates: independent verification could neither confirm nor refute them. Not counted as findings._',
    );
    investigate.forEach((finding, i) => {
      parts.push(formatFinding({ ...finding, index: i + 1 }, {}).replace(/ \(open\)/, ''));
    });
    parts.push('');
  }
  parts.push('_Generated by Project X — read-only review handoff. Not posted to GitHub._');

  return `${parts.join('\n').trim()}\n`;
}

/**
 * Clipboard-ready PR comment draft for manual paste (Day 10 handoff — no GitHub write).
 */
export function buildPrReviewCommentDraft(
  report: PRReviewReport,
  dispositions: PrFindingDispositionMap = {},
): string {
  const openFindings = report.findings.filter((finding) => !dispositions[finding.id]);
  const reviewedCount = report.findings.filter((f) => dispositions[f.id] === 'reviewed').length;
  const ignoredCount = report.findings.filter((f) => dispositions[f.id] === 'ignored').length;

  const lines: string[] = [
    `### Project X review — ${report.repository.owner}/${report.repository.name} #${report.pullRequest.number}`,
    '',
    `**Risk:** ${riskLabel(report)}`,
    '',
    ...(isUnverifiedPageScope(report.reviewScope) ? [`> ${PAGE_FALLBACK_NOTICE}`, ''] : []),
    ...(report.completeness?.complete === false
      ? ['> Incomplete review — not every risk may be listed.', '']
      : report.reviewScope?.truncated
        ? [
            `> Partial coverage — ${formatReviewedFilesLabel(report)}; unreviewed files may contain risks.`,
            '',
          ]
        : []),
    ...(report.needsInvestigation?.length
      ? [
          `> ${report.needsInvestigation.length} possible issue${report.needsInvestigation.length === 1 ? '' : 's'} still need investigation (not listed below).`,
          '',
        ]
      : []),
    report.overview,
    '',
  ];

  if (openFindings.length > 0) {
    lines.push('**Open findings**');
    for (const finding of openFindings) {
      const path = finding.filePath ? `\`${finding.filePath}\`` : 'unspecified file';
      lines.push(
        `- **[${severityLabel(finding.severity)}]** ${path} — ${finding.title}${finding.why ? ` (${finding.why})` : ''}`,
      );
    }
    lines.push('');
  }

  if (reviewedCount > 0 || ignoredCount > 0) {
    lines.push(
      `_Session: ${reviewedCount} marked reviewed · ${ignoredCount} ignored · not posted by Project X._`,
    );
  } else {
    lines.push(
      '_Generated by Project X. Paste manually or use Post to GitHub from the extension._',
    );
  }

  return `${lines.join('\n').trim()}\n`;
}
