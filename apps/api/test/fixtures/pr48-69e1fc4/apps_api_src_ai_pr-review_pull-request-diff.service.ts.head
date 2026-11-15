import { Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import {
  PR_DIFF_UNAVAILABLE_CODE,
  type PageContextChangedFile,
  type PRReviewScope,
} from '@project-x/types';

import { GithubAccessService } from '@/github-app/github-access.service';
import {
  budgetPullRequestFiles,
  PR_DIFF_MAX_PAGES,
  scopeFromPageFiles,
  type GitHubPullFile,
} from './pr-diff-budget';

const GITHUB_NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const GITHUB_TIMEOUT_MS = 10_000;

export type PullRequestDiffInput = {
  userId: string;
  workspaceId: string;
  owner?: string | null;
  repository?: string | null;
  pullRequestNumber?: number | null;
  /** Best-effort files scraped from the page; used only when the API fetch fails. */
  pageFiles?: PageContextChangedFile[];
  pageTruncated?: boolean;
};

export type PullRequestDiffResult = {
  changedFiles: PageContextChangedFile[];
  scope: PRReviewScope;
  pullRequestTitle?: string;
  baseBranch?: string;
  headBranch?: string;
};

type FetchFailureReason = 'not_connected' | 'no_access' | 'token_rejected' | 'unavailable';

class GitHubDiffFetchError extends Error {
  constructor(readonly reason: FetchFailureReason) {
    super(reason);
  }
}

const FAILURE_MESSAGES: Record<FetchFailureReason | 'not_a_pr', string> = {
  not_a_pr: 'Open a GitHub pull request page (owner/repo/pull/<number>) to review the entire PR.',
  not_connected:
    'Could not load the PR diff: connect GitHub in dashboard Settings (or install the GitHub App), or open the Files changed tab and try again.',
  no_access:
    'Could not load the PR diff: the connected GitHub account cannot access this repository.',
  token_rejected:
    'Could not load the PR diff: GitHub rejected the stored token. Update it in dashboard Settings.',
  unavailable: 'Could not load the PR diff from GitHub right now. Try again in a moment.',
};

/**
 * Loads the authoritative PR diff from the GitHub API for REVIEW_ENTIRE_PR.
 * Falls back to page-scraped files only when GitHub cannot be used; when neither yields a
 * diff, throws PR_DIFF_UNAVAILABLE so the AI is never called on an empty review scope.
 */
@Injectable()
export class PullRequestDiffService {
  private readonly logger = new Logger(PullRequestDiffService.name);

  constructor(private readonly githubAccess: GithubAccessService) {}

  async resolve(input: PullRequestDiffInput): Promise<PullRequestDiffResult> {
    const owner = input.owner?.trim() ?? '';
    const repository = input.repository?.trim() ?? '';
    const number = input.pullRequestNumber ?? 0;
    const identified =
      GITHUB_NAME_RE.test(owner) &&
      GITHUB_NAME_RE.test(repository) &&
      Number.isInteger(number) &&
      number > 0 &&
      number < 1_000_000_000;

    let failure: FetchFailureReason | 'not_a_pr' = 'not_a_pr';
    if (identified) {
      try {
        const result = await this.fetchFromGitHub(input.userId, input.workspaceId, {
          owner,
          repository,
          number,
        });
        this.logger.log({ msg: 'pr_review.diff.loaded', ...result.scope });
        return result;
      } catch (error) {
        failure = error instanceof GitHubDiffFetchError ? error.reason : 'unavailable';
      }
    }

    const pageScope = scopeFromPageFiles(input.pageFiles, input.pageTruncated);
    if (pageScope.analyzedFiles > 0) {
      this.logger.warn({
        msg: 'pr_review.diff.page_fallback',
        reason: failure,
        ...pageScope,
      });
      return { changedFiles: input.pageFiles ?? [], scope: pageScope };
    }

    this.logger.warn({ msg: 'pr_review.diff.unavailable', reason: failure });
    throw new UnprocessableEntityException({
      statusCode: 422,
      code: PR_DIFF_UNAVAILABLE_CODE,
      reason: failure,
      message: FAILURE_MESSAGES[failure],
    });
  }

  private async fetchFromGitHub(
    userId: string,
    workspaceId: string,
    pr: { owner: string; repository: string; number: number },
  ): Promise<PullRequestDiffResult> {
    const resolved = await this.githubAccess.resolveApiToken(userId, workspaceId);
    if (!resolved) {
      throw new GitHubDiffFetchError('not_connected');
    }

    const base = `https://api.github.com/repos/${encodeURIComponent(pr.owner)}/${encodeURIComponent(pr.repository)}/pulls/${pr.number}`;
    const meta = (await this.getJson(base, resolved.token)) as {
      title?: string;
      changed_files?: number;
      base?: { ref?: string };
      head?: { ref?: string };
    };
    const totalFiles = typeof meta.changed_files === 'number' ? meta.changed_files : null;

    const files: GitHubPullFile[] = [];
    for (let page = 1; page <= PR_DIFF_MAX_PAGES; page += 1) {
      const batch = (await this.getJson(
        `${base}/files?per_page=100&page=${page}`,
        resolved.token,
      )) as GitHubPullFile[];
      if (!Array.isArray(batch)) break;
      files.push(...batch);
      if (batch.length < 100 || (totalFiles !== null && files.length >= totalFiles)) break;
    }

    const { changedFiles, scope } = budgetPullRequestFiles(files, totalFiles);
    return {
      changedFiles,
      scope,
      ...(meta.title ? { pullRequestTitle: meta.title.slice(0, 200) } : {}),
      ...(meta.base?.ref ? { baseBranch: meta.base.ref.slice(0, 200) } : {}),
      ...(meta.head?.ref ? { headBranch: meta.head.ref.slice(0, 200) } : {}),
    };
  }

  private async getJson(url: string, token: string): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'Project-X',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      });
    } catch {
      throw new GitHubDiffFetchError('unavailable');
    }
    if (response.status === 401) throw new GitHubDiffFetchError('token_rejected');
    if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
      throw new GitHubDiffFetchError('unavailable');
    }
    if (response.status === 403 || response.status === 404) {
      throw new GitHubDiffFetchError('no_access');
    }
    if (!response.ok) throw new GitHubDiffFetchError('unavailable');
    try {
      return await response.json();
    } catch {
      throw new GitHubDiffFetchError('unavailable');
    }
  }
}
