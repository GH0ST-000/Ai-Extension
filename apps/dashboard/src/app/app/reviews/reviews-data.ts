import type {
  PrReviewHistoryItem,
  PrReviewHistoryPage,
  PrReviewHistoryQuery,
  PrReviewReportDetail,
  PrReviewReportFinding,
  PrReviewReportStatus,
} from '@project-x/types';

import { apiFetch } from '@/lib/api';
import { renderDownstreamImpactSection } from '@project-x/shared';

/** Read-only history API. None of these calls runs the AI, charges usage or writes to GitHub. */
function basePath(workspaceId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}/pr-reviews`;
}

export async function listPrReviewHistory(
  workspaceId: string,
  query: PrReviewHistoryQuery,
  signal?: AbortSignal,
): Promise<PrReviewHistoryPage> {
  const params = new URLSearchParams();
  if (query.owner) params.set('owner', query.owner);
  if (query.repository) params.set('repository', query.repository);
  if (query.pullRequestNumber) params.set('pullRequestNumber', String(query.pullRequestNumber));
  if (query.status) params.set('status', query.status);
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.limit) params.set('limit', String(query.limit));
  const qs = params.toString();
  return apiFetch<PrReviewHistoryPage>(`${basePath(workspaceId)}${qs ? `?${qs}` : ''}`, {
    workspaceId,
    ...(signal ? { signal } : {}),
  });
}

/** Extra requests made to fill one visible page when the server returns short pages. */
export const MAX_FOLLOW_UP_REQUESTS = 4;

/**
 * One visible page. The server may return a short (even empty) page with a cursor when its
 * per-request scan budget was reached; follow it a few times so the user is not shown an
 * empty list while accessible reviews exist further back. Stops early when GitHub could not
 * confirm access (the caller shows that and offers to continue).
 */
export async function loadHistoryPage(
  workspaceId: string,
  query: PrReviewHistoryQuery,
  signal?: AbortSignal,
): Promise<PrReviewHistoryPage> {
  const limit = query.limit ?? 20;
  let page = await listPrReviewHistory(workspaceId, query, signal);
  const merged: PrReviewHistoryPage = { ...page, items: [...page.items] };
  for (let i = 0; i < MAX_FOLLOW_UP_REQUESTS; i += 1) {
    if (merged.items.length >= limit || !page.nextCursor || page.accessCheckIncomplete) break;
    page = await listPrReviewHistory(
      workspaceId,
      { ...query, cursor: page.nextCursor, limit: limit - merged.items.length },
      signal,
    );
    merged.items.push(...page.items);
    merged.nextCursor = page.nextCursor;
    merged.someRepositoriesHidden ||= page.someRepositoriesHidden;
    merged.accessCheckIncomplete = page.accessCheckIncomplete;
  }
  return merged;
}

export async function getPrReviewReport(
  workspaceId: string,
  reportId: string,
  signal?: AbortSignal,
): Promise<PrReviewReportDetail> {
  return apiFetch<PrReviewReportDetail>(
    `${basePath(workspaceId)}/${encodeURIComponent(reportId)}`,
    { workspaceId, ...(signal ? { signal } : {}) },
  );
}

/** Parse "owner/repo" (or a github.com URL) into filter fields; null when invalid. */
export function parseRepositoryFilter(value: string): { owner: string; repository: string } | null {
  const trimmed = value
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
  const match = /^([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})$/.exec(
    trimmed,
  );
  return match ? { owner: match[1]!, repository: match[2]! } : null;
}

export function parsePullRequestFilter(value: string): number | null {
  const trimmed = value.trim().replace(/^#/, '');
  if (!/^\d{1,10}$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return n >= 1 && n <= 2_147_483_647 ? n : null;
}

export const STATUS_LABELS: Record<PrReviewReportStatus, string> = {
  completed: 'Complete',
  partial: 'Partial',
  failed: 'Failed',
};

export function coverageLabel(item: PrReviewHistoryItem): string {
  if (item.status === 'failed') return 'Not reviewed';
  if (item.filesTotal === null) return `${item.filesReviewed} files reviewed`;
  return `${item.filesReviewed}/${item.filesTotal} files`;
}

export function findingsLabel(item: PrReviewHistoryItem): string {
  if (item.status === 'failed') return '—';
  const base = `${item.findingsCount} finding${item.findingsCount === 1 ? '' : 's'}`;
  return item.needsInvestigationCount > 0
    ? `${base} · ${item.needsInvestigationCount} to investigate`
    : base;
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const FAILURE_LABELS: Record<string, string> = {
  all_batches_failed: 'Every review batch failed. No usage was charged.',
  orchestrator_error: 'The review could not run. No usage was charged.',
  some_batches_failed: 'Some review batches failed; their files were not reviewed.',
};

export function failureLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  return FAILURE_LABELS[code] ?? 'The review did not finish.';
}

/** Machine trailers (`[[px:…]]`) are for clients, not for people reading the export. */
export function stripMachineTrailers(markdown: string): string {
  return markdown
    .split('\n')
    .filter((line) => !/^\s*\[\[px:[a-z-]+[\s\S]*\]\]\s*$/.test(line))
    .join('\n')
    .trimEnd();
}

function findingMarkdown(finding: PrReviewReportFinding): string {
  const lines =
    finding.lineStart !== null
      ? `:${finding.lineStart}${finding.lineEnd && finding.lineEnd !== finding.lineStart ? `-${finding.lineEnd}` : ''}`
      : '';
  const parts = [
    `### [${finding.severity.toUpperCase()}] ${finding.title}`,
    `\`${finding.path}${lines}\` · ${finding.category} · confidence ${finding.confidence}`,
    '',
    finding.explanation,
  ];
  if (finding.impact) parts.push('', `**Impact:** ${finding.impact}`);
  if (finding.evidence) {
    const fence = finding.evidence.includes('```') ? '~~~~' : '```';
    parts.push('', fence, finding.evidence, fence);
  }
  return parts.join('\n');
}

/**
 * Markdown export of a saved report: a header identifying the snapshot, then the report as it
 * was delivered (machine trailers removed), or a summary built from the stored snapshot when
 * no delivered text exists (failed runs, very large reports).
 */
export function buildHistoryMarkdown(report: PrReviewReportDetail): string {
  const header = [
    `# PR review — ${report.owner}/${report.repository}#${report.pullRequestNumber}`,
    '',
    ...(report.pullRequestTitle ? [`**${report.pullRequestTitle}**`, ''] : []),
    `- Saved review: ${report.completedAt}`,
    `- Status: ${STATUS_LABELS[report.status]}${report.riskLevel ? ` · risk ${report.riskLevel}` : ''}`,
    `- Coverage: ${coverageLabel(report)}${report.coverageComplete ? ' (complete)' : ''}`,
    ...(report.headSha ? [`- Head commit: ${report.headSha}`] : []),
    `- Project Memory: ${report.memoryMode === 'off' ? 'off' : (report.memoryStatus ?? 'unknown')}`,
    `- Report id: ${report.id}`,
  ];
  const failure = failureLabel(report.snapshot.failure?.code ?? report.failureCode);
  if (failure) header.push('', `> ${failure}`);

  let body: string;
  if (report.reportMarkdown) {
    body = stripMachineTrailers(report.reportMarkdown);
  } else if (report.snapshot.findings.length > 0) {
    const reported = report.snapshot.findings.filter((f) => f.disposition === 'reported');
    const investigate = report.snapshot.findings.filter(
      (f) => f.disposition === 'needs_investigation',
    );
    body = [
      '## Findings',
      '',
      reported.length ? reported.map(findingMarkdown).join('\n\n') : '_No findings._',
      ...(investigate.length
        ? ['', '## Needs investigation', '', investigate.map(findingMarkdown).join('\n\n')]
        : []),
    ].join('\n');
  } else {
    body = report.status === 'failed' ? '_No report was produced._' : '_No findings._';
  }
  // Re-authorized for this viewer by the API; the stored report Markdown never contains it.
  const impact = report.snapshot.downstreamImpact
    ? renderDownstreamImpactSection(report.snapshot.downstreamImpact)
    : null;
  if (impact) body = `${impact}\n\n${body}`;
  return `${header.join('\n')}\n\n---\n\n${body}\n`;
}

export function historyExportFilename(report: PrReviewHistoryItem): string {
  const date = report.completedAt.slice(0, 10);
  const safe = `${report.owner}-${report.repository}-pr${report.pullRequestNumber}-${date}`
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-');
  return `${safe}.md`;
}
