/**
 * Accurate GitHub trust copy for Day 28.
 * Project X uses a user-provided PAT stored encrypted on the API — not a GitHub App install.
 */

export const GITHUB_TRUST_SUMMARY =
  'Project X can access the repositories your token authorizes. Comments, reviews, and patch commits are only performed after you explicitly confirm each write.';

export const GITHUB_WHY_CONNECT =
  'Connect GitHub to review pull requests, analyze CI failures, generate fixes, and post comments when you explicitly confirm them.';

export const GITHUB_READS = [
  'Pull request metadata and changed files/diffs you request',
  'CI / check information needed for failure analysis',
  'Repository files required for the specific action you start',
] as const;

export const GITHUB_WRITES = [
  'Pull request comments',
  'Pull request reviews',
  'Approved patch commits',
] as const;

export const GITHUB_WRITE_CONFIRMATION_NOTE =
  'Project X never posts comments, submits reviews, or applies code changes without your explicit confirmation.';

export const GITHUB_PERMISSION_DETAILS = [
  {
    title: 'Pull requests',
    body: 'Read for reviews and analysis. Write only after you confirm Post Comment, Submit Review, or Apply Fix.',
  },
  {
    title: 'Contents',
    body: 'Read files needed for analysis or patch preparation. Write only for confirmed Apply Fix commits.',
  },
  {
    title: 'Checks',
    body: 'Read check runs and logs for CI analysis. Project X does not rerun CI.',
  },
] as const;

export function formatGitHubConnectionLabel(input: {
  connected: boolean;
  githubLogin?: string | null;
}): string {
  if (!input.connected) {
    return 'Not connected';
  }
  if (input.githubLogin?.trim()) {
    return `Connected as ${input.githubLogin.trim()}`;
  }
  return 'Connected';
}
