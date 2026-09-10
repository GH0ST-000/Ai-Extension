import type { PRReviewFinding, PRReviewReport } from '@project-x/types';
import type { GitHubReviewDraft, GitHubReviewDraftComment } from '@project-x/types';

export function createDraftCommentId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `c-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createDraftId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `d-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Initial comment body from a finding. No AI call — reuses report content.
 * (GENERATE_PR_COMMENT is not a separate AIAction in this codebase.)
 */
export function buildFindingReviewCommentBody(finding: PRReviewFinding): string {
  const parts = [`**${finding.title}**`];
  if (finding.why.trim()) {
    parts.push(finding.why.trim());
  }
  if (finding.filePath) {
    parts.push(`\n\n_File: \`${finding.filePath}\`_`);
  }
  return parts.join('\n\n').trim();
}

export function findingToDraftComment(finding: PRReviewFinding): GitHubReviewDraftComment {
  const body = buildFindingReviewCommentBody(finding);
  return {
    id: createDraftCommentId(),
    findingId: finding.id,
    originalBody: body,
    body,
    filePath: finding.filePath,
    enabled: true,
    mode: 'pr',
    // No trusted line metadata in Day 10 findings — never guess.
    positionStatus: 'unavailable',
    severity: finding.severity,
    findingTitle: finding.title,
    removed: false,
  };
}

export function createReviewDraftFromReport(
  report: PRReviewReport,
  options?: { sourceReviewSessionId?: string; expectedHeadSha?: string },
): GitHubReviewDraft {
  return {
    id: createDraftId(),
    destination: {
      owner: report.repository.owner,
      repository: report.repository.name,
      pullRequestNumber: report.pullRequest.number,
    },
    event: 'COMMENT',
    body: report.overview.trim(),
    comments: [],
    createdAt: new Date().toISOString(),
    sourceReviewSessionId: options?.sourceReviewSessionId,
    expectedHeadSha: options?.expectedHeadSha,
    staleNavigation: false,
  };
}

/**
 * Aggregate PR-level notes into the overall review body (no AI).
 */
export function buildAggregatedReviewBody(
  overallBody: string,
  prLevelNotes: Array<{ filePath?: string; body: string }>,
): string {
  const base = overallBody.trim();
  if (prLevelNotes.length === 0) {
    return base;
  }

  const section = [
    '### Additional review notes',
    '',
    ...prLevelNotes.map((note) => {
      const label = note.filePath ? `\`${note.filePath}\`` : '_general_';
      return `- ${label}: ${note.body.trim()}`;
    }),
  ].join('\n');

  return base ? `${base}\n\n${section}` : section;
}

export function activeDraftComments(draft: GitHubReviewDraft): GitHubReviewDraftComment[] {
  return draft.comments.filter((comment) => comment.enabled && !comment.removed);
}
