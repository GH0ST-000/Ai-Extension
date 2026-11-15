import {
  PR_REVIEW_COVERAGE_MARKER,
  PR_REVIEW_INCOMPLETE_MARKER,
  type PRReviewCoverage,
} from '@project-x/types';

import type { ValidatedFinding } from './pr-review-findings';

export function encodeCoverage(coverage: PRReviewCoverage): string {
  return Buffer.from(JSON.stringify(coverage), 'utf8').toString('base64url');
}

function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${n} ${n === 1 ? word : pluralWord}`;
}

/** One deterministic sentence describing exactly what was and was not reviewed. */
export function coverageSentence(coverage: PRReviewCoverage): string {
  const c = coverage.counts;
  const total = coverage.totalFiles ?? coverage.files.length + c.not_fetched;
  // Page fallback: the PR's real file count is unknown, so never state "N of M changed files".
  const pageFallback = coverage.source === 'page' && coverage.totalFiles === null;
  const parts = [
    pageFallback
      ? `Coverage: unverified — the GitHub API was unavailable, so files were collected from the GitHub page and the PR's total number of changed files is unknown; ${c.reviewed_full} of ${plural(total, 'file')} found on the page fully reviewed`
      : `Coverage: ${c.reviewed_full} of ${plural(total, 'changed file')} fully reviewed`,
  ];
  const details: string[] = [];
  if (c.reviewed_partial) details.push(`${c.reviewed_partial} partially`);
  if (c.deferred_budget) details.push(`${c.deferred_budget} deferred (review budget)`);
  if (c.review_failed) details.push(`${c.review_failed} not reviewed (failed batch)`);
  if (c.no_patch) details.push(`${c.no_patch} without a diff from GitHub`);
  if (c.not_fetched) details.push(`${c.not_fetched} not listed by GitHub`);
  const excluded = c.excluded_generated + c.excluded_binary + c.excluded_no_changes;
  if (excluded) details.push(`${excluded} excluded (generated, binary or rename-only)`);
  const failed = coverage.batches.filter((b) => b.status !== 'succeeded').length;
  if (failed)
    details.push(`${failed} of ${plural(coverage.batches.length, 'batch', 'batches')} failed`);
  return `${parts[0]}${details.length ? `; ${details.join('; ')}` : ''}.`;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

const CHANGE_LABEL: Record<ValidatedFinding['changeType'], string> = {
  introduced: 'introduced by this PR',
  removed_safeguard: 'safeguard removed by this PR',
  exposed_existing: 'existing defect exposed by this PR',
  pre_existing: 'pre-existing, not introduced by this PR',
};

const VERIFICATION_LABEL: Record<ValidatedFinding['verification']['status'], string> = {
  not_required: 'not required (low severity)',
  pending: 'pending',
  confirmed: 'confirmed by independent verification',
  refuted: 'refuted',
  insufficient_context: 'insufficient context to confirm or refute',
  unavailable: 'not run',
  unverified: 'UNVERIFIED — low severity, not independently confirmed',
};

function renderFinding(f: ValidatedFinding, index: number): string {
  const lines =
    f.lineStart != null
      ? f.lineEnd != null && f.lineEnd !== f.lineStart
        ? `L${f.lineStart}-L${f.lineEnd}`
        : `L${f.lineStart}`
      : null;
  const claimed = f.claimedLines
    ? ` (model cited L${f.claimedLines.start}${f.claimedLines.end !== f.claimedLines.start ? `-L${f.claimedLines.end}` : ''}, which does not contain the quoted evidence)`
    : '';
  const verification = `${VERIFICATION_LABEL[f.verification.status]}${
    f.verification.reason && f.verification.status !== 'not_required'
      ? ` — ${oneLine(f.verification.reason)}`
      : ''
  }`;
  // "│ " prefix: evidence lines can never look like a new numbered finding to parsers.
  const evidence = f.evidence
    .split('\n')
    .map((l) => `   │ ${l}`)
    .join('\n');
  return [
    `${index + 1}. **[${f.severity}]** \`${f.path}\` — ${oneLine(f.title)}`,
    `   Why: ${oneLine(f.explanation)}`,
    `   Category: ${f.category} · Confidence: ${f.confidence}`,
    `   Change: ${CHANGE_LABEL[f.changeType]}`,
    `   Verification: ${verification}`,
    ...(f.trigger ? [`   Trigger: ${oneLine(f.trigger)}`] : []),
    ...(f.failurePath ? [`   Failure path: ${oneLine(f.failurePath)}`] : []),
    ...(f.impact ? [`   Impact: ${oneLine(f.impact)}`] : []),
    ...(f.disposition === 'needs_investigation' && f.missingContext
      ? [`   Missing context: ${oneLine(f.missingContext)}`]
      : []),
    ...(lines ? [`   Lines: ${lines}${claimed}`] : []),
    ...(f.alsoIn.length ? [`   Also in: ${f.alsoIn.map((p) => `\`${p}\``).join(', ')}`] : []),
    `   Ref: ${f.stableId}`,
    '   Evidence:',
    evidence,
  ].join('\n');
}

function countBy(findings: ValidatedFinding[]): string {
  const n = (s: string) => findings.filter((f) => f.severity === s).length;
  return [`${n('high')} high`, `${n('medium')} medium`, `${n('low')} low`].join(', ');
}

/**
 * Deterministic overview from coverage and findings only — no concatenated batch summaries.
 */
export function buildOverview(coverage: PRReviewCoverage, findings: ValidatedFinding[]): string {
  const reported = findings.filter((f) => f.disposition === 'reported');
  const investigate = findings.filter((f) => f.disposition === 'needs_investigation');
  const dismissed = findings.filter((f) => f.disposition === 'dismissed').length;
  const parts = [coverageSentence(coverage)];
  parts.push(
    reported.length
      ? `Reported findings: ${reported.length} (${countBy(reported)}).`
      : 'No verified findings.',
  );
  if (investigate.length) {
    parts.push(
      `Needs investigation: ${investigate.length} candidate${investigate.length === 1 ? '' : 's'} (${countBy(investigate)}) could not be confirmed or refuted — review them before treating this PR as low risk.`,
    );
  }
  if (dismissed) {
    parts.push(
      `${dismissed} candidate${dismissed === 1 ? ' was' : 's were'} refuted by independent verification.`,
    );
  }
  const top = reported[0];
  if (top && top.severity !== 'low') {
    parts.push(`Top risk: [${top.severity}] ${top.path} — ${oneLine(top.title)}.`);
  }
  return parts.join(' ');
}

/**
 * Markdown in the format clients parse (## Summary / ## Risk Findings / numbered findings
 * with "Why:"), an optional ## Needs Investigation section, then the machine-readable
 * coverage trailer. When coverage is partial an incomplete marker is appended last, so older
 * clients that do not understand the coverage trailer still refuse to show the review as
 * clean. Older clients read Needs Investigation items as findings (the safe direction).
 */
export function renderPrReview(input: {
  coverage: PRReviewCoverage;
  findings: ValidatedFinding[];
}): string {
  const { coverage } = input;
  const reported = input.findings.filter((f) => f.disposition === 'reported');
  const investigate = input.findings.filter((f) => f.disposition === 'needs_investigation');

  const body =
    reported.length === 0
      ? coverage.complete && investigate.length === 0
        ? 'No material risks found.'
        : 'No material risks verified in the reviewed files. Unreviewed files and open candidates may still contain risks.'
      : reported.map(renderFinding).join('\n');

  const parts = [
    '## Summary',
    buildOverview(coverage, input.findings),
    '',
    '## Risk Findings',
    body,
  ];
  if (investigate.length > 0) {
    parts.push('', '## Needs Investigation', investigate.map(renderFinding).join('\n'));
  }
  parts.push('', `${PR_REVIEW_COVERAGE_MARKER} ${encodeCoverage(coverage)}]]`);
  if (!coverage.complete) {
    parts.push(`${PR_REVIEW_INCOMPLETE_MARKER} reason=partial-coverage]]`);
  }
  return parts.join('\n');
}
