import { Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import {
  PR_DIFF_UNAVAILABLE_CODE,
  type PageContextChangedFile,
  type PRReviewDiffSource,
} from '@project-x/types';

import { GithubAccessService } from '@/github-app/github-access.service';
import type { FileContentProvider } from './pr-review-context';
import {
  isBinaryPath,
  normalizeGitHubFiles,
  type ChangedFile,
  type GitHubPullFile,
} from './pr-review-files';

const GITHUB_NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const GITHUB_TIMEOUT_MS = 10_000;
/**
 * Pages of 100 files listed from GitHub (1,000 files). GitHub itself caps the endpoint at
 * 3,000 files; files beyond what was listed are reported as `not_fetched`, never dropped.
 */
export const PR_DIFF_MAX_PAGES = 10;
const PER_PAGE = 100;
/** Context files larger than this are skipped (context is optional, never truncated mid-file). */
const MAX_CONTEXT_FILE_BYTES = 300_000;
const SHA_RE = /^[0-9a-f]{7,64}$/i;

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

/** Every changed file the API could list — selection and budgeting happen in the planner. */
export type PullRequestDiffResult = {
  source: PRReviewDiffSource;
  files: ChangedFile[];
  /** GitHub's changed_files count (may exceed `files.length`), or null for the page fallback. */
  totalFiles: number | null;
  pullRequestTitle?: string;
  baseBranch?: string;
  headBranch?: string;
  headSha?: string;
  /** Base commit of the PR (immutable; GitHub API only). */
  baseSha?: string;
};

/** Categorized result of reading one file at an immutable commit. */
export type FileAtRefResult =
  | { ok: true; text: string }
  | {
      ok: false;
      reason: 'not_found' | 'no_access' | 'rate_limited' | 'too_large' | 'unavailable' | 'invalid';
    };

type FetchFailureReason =
  'not_connected' | 'identity_required' | 'no_access' | 'token_rejected' | 'unavailable';

class GitHubDiffFetchError extends Error {
  constructor(readonly reason: FetchFailureReason) {
    super(reason);
  }
}

const FAILURE_MESSAGES: Record<FetchFailureReason | 'not_a_pr', string> = {
  not_a_pr: 'Open a GitHub pull request page (owner/repo/pull/<number>) to review the entire PR.',
  not_connected:
    'Could not load the PR diff: connect GitHub in dashboard Settings (or install the GitHub App), or open the Files changed tab and try again.',
  identity_required:
    'Could not load the PR diff: this workspace uses the Project X GitHub App — connect your own GitHub token in dashboard Settings so Project X can confirm your access, or open the Files changed tab and try again.',
  no_access:
    'Could not load the PR diff: the connected GitHub account cannot access this repository.',
  token_rejected:
    'Could not load the PR diff: GitHub rejected the stored token. Update it in dashboard Settings.',
  unavailable: 'Could not load the PR diff from GitHub right now. Try again in a moment.',
};

/** Page-scraped files: best-effort excerpts, never treated as the full diff. */
function filesFromPage(files: PageContextChangedFile[] | undefined): ChangedFile[] {
  const seen = new Set<string>();
  const out: ChangedFile[] = [];
  for (const file of files ?? []) {
    const path = file.path?.trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const patch = file.patchExcerpt?.trim() ? file.patchExcerpt : null;
    out.push({ path, status: 'modified', changes: patch ? 1 : 0, patch });
  }
  return out;
}

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
        this.logger.log({
          msg: 'pr_review.diff.loaded',
          source: result.source,
          totalFiles: result.totalFiles,
          listedFiles: result.files.length,
        });
        return result;
      } catch (error) {
        failure = error instanceof GitHubDiffFetchError ? error.reason : 'unavailable';
      }
    }

    const pageFiles = filesFromPage(input.pageFiles);
    if (pageFiles.some((file) => file.patch)) {
      this.logger.warn({
        msg: 'pr_review.diff.page_fallback',
        reason: failure,
        listedFiles: pageFiles.length,
        pageTruncated: Boolean(input.pageTruncated),
      });
      return { source: 'page', files: pageFiles, totalFiles: null };
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
    // H1: the acting user's own read access is verified before an App token is used.
    const resolved = await this.githubAccess.resolveRepositoryAccess(userId, {
      owner: pr.owner,
      repository: pr.repository,
      access: 'read',
      workspaceId,
    });
    if (!resolved.ok) {
      throw new GitHubDiffFetchError(
        resolved.reason === 'insufficient_permission' ? 'no_access' : resolved.reason,
      );
    }

    const base = `https://api.github.com/repos/${encodeURIComponent(pr.owner)}/${encodeURIComponent(pr.repository)}/pulls/${pr.number}`;
    const meta = (await this.getJson(base, resolved.token)) as {
      title?: string;
      changed_files?: number;
      base?: { ref?: string; sha?: string };
      head?: { ref?: string; sha?: string };
    };
    const totalFiles = typeof meta.changed_files === 'number' ? meta.changed_files : null;

    // List every page before any selection happens; the planner prioritizes afterwards.
    const raw: GitHubPullFile[] = [];
    for (let page = 1; page <= PR_DIFF_MAX_PAGES; page += 1) {
      const batch = (await this.getJson(
        `${base}/files?per_page=${PER_PAGE}&page=${page}`,
        resolved.token,
      )) as GitHubPullFile[];
      if (!Array.isArray(batch)) break;
      raw.push(...batch);
      if (batch.length < PER_PAGE || (totalFiles !== null && raw.length >= totalFiles)) break;
    }

    const headSha = meta.head?.sha;
    const baseSha = meta.base?.sha;
    return {
      source: 'github_api',
      files: normalizeGitHubFiles(raw),
      totalFiles,
      ...(meta.title ? { pullRequestTitle: meta.title.slice(0, 200) } : {}),
      ...(meta.base?.ref ? { baseBranch: meta.base.ref.slice(0, 200) } : {}),
      ...(meta.head?.ref ? { headBranch: meta.head.ref.slice(0, 200) } : {}),
      ...(headSha && /^[0-9a-f]{7,64}$/i.test(headSha) ? { headSha } : {}),
      ...(baseSha && /^[0-9a-f]{7,64}$/i.test(baseSha) ? { baseSha } : {}),
    };
  }

  /**
   * Read one file at an immutable commit SHA with the same workspace-scoped credentials as
   * the diff. Unlike the context file provider, failures are categorized so callers can tell
   * "file does not exist at this commit" from "access denied" or "rate limited". Never follows
   * URLs from repository content: owner, repository, path and SHA are validated first.
   */
  async fetchFileAtRef(input: {
    userId: string;
    workspaceId: string;
    owner: string;
    repository: string;
    sha: string;
    path: string;
    maxBytes: number;
    signal?: AbortSignal;
  }): Promise<FileAtRefResult> {
    const path = input.path.trim();
    if (
      !GITHUB_NAME_RE.test(input.owner) ||
      !GITHUB_NAME_RE.test(input.repository) ||
      !/^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(input.sha) ||
      !path ||
      path.length > 1_000 ||
      path.startsWith('/') ||
      path.split('/').some((seg) => seg === '..' || seg === '.' || seg === '')
    ) {
      return { ok: false, reason: 'invalid' };
    }
    let token: string | null;
    try {
      const resolved = await this.githubAccess.resolveRepositoryAccess(input.userId, {
        owner: input.owner,
        repository: input.repository,
        access: 'read',
        workspaceId: input.workspaceId,
      });
      if (!resolved.ok) {
        return {
          ok: false,
          reason: resolved.reason === 'unavailable' ? 'unavailable' : 'no_access',
        };
      }
      token = resolved.token;
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
    const url = `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/contents/${path
      .split('/')
      .map(encodeURIComponent)
      .join('/')}?ref=${input.sha}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github.raw+json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'Project-X',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        signal: input.signal
          ? AbortSignal.any([AbortSignal.timeout(GITHUB_TIMEOUT_MS), input.signal])
          : AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      });
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
    if (response.status === 404) return { ok: false, reason: 'not_found' };
    if (
      response.status === 429 ||
      (response.status === 403 &&
        (response.headers.get('x-ratelimit-remaining') === '0' ||
          response.headers.has('retry-after')))
    ) {
      return { ok: false, reason: 'rate_limited' };
    }
    if (response.status === 401 || response.status === 403)
      return { ok: false, reason: 'no_access' };
    if (!response.ok) return { ok: false, reason: 'unavailable' };
    const length = Number(response.headers.get('content-length') ?? '0');
    if (length > input.maxBytes) return { ok: false, reason: 'too_large' };
    let text: string;
    try {
      text = await response.text();
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
    if (Buffer.byteLength(text, 'utf8') > input.maxBytes) return { ok: false, reason: 'too_large' };
    if (text.includes('\u0000')) return { ok: false, reason: 'invalid' };
    return { ok: true, text };
  }

  /**
   * Read-only file loader for review context at the PR head SHA. Uses the same
   * workspace-scoped credentials as the diff (GitHub App installation of the acting
   * workspace, else the user's PAT), validates the repository identity and path, memoizes
   * per path, and stops after `maxFiles` distinct fetches. Any failure yields null.
   */
  createFileProvider(input: {
    userId: string;
    workspaceId: string;
    owner: string;
    repository: string;
    ref: string | undefined;
    maxFiles: number;
  }): FileContentProvider {
    const valid =
      GITHUB_NAME_RE.test(input.owner) &&
      GITHUB_NAME_RE.test(input.repository) &&
      typeof input.ref === 'string' &&
      SHA_RE.test(input.ref) &&
      input.maxFiles > 0;
    const cache = new Map<string, Promise<string | null>>();
    let token: Promise<string | null> | undefined;
    const getToken = () =>
      (token ??= this.githubAccess
        .resolveRepositoryAccess(input.userId, {
          owner: input.owner,
          repository: input.repository,
          access: 'read',
          workspaceId: input.workspaceId,
        })
        .then((r) => (r.ok ? r.token : null))
        .catch(() => null));

    return (pathRaw: string, signal?: AbortSignal) => {
      const path = pathRaw.trim();
      if (
        !valid ||
        !path ||
        path.length > 1_000 ||
        path.startsWith('/') ||
        path.split('/').some((seg) => seg === '..' || seg === '.' || seg === '') ||
        isBinaryPath(path)
      ) {
        return Promise.resolve(null);
      }
      const cached = cache.get(path);
      if (cached) return cached;
      if (cache.size >= input.maxFiles || signal?.aborted) return Promise.resolve(null);
      const load = (async () => {
        const t = await getToken();
        if (!t) return null;
        const url = `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/contents/${path
          .split('/')
          .map(encodeURIComponent)
          .join('/')}?ref=${input.ref}`;
        try {
          const response = await fetch(url, {
            method: 'GET',
            headers: {
              Accept: 'application/vnd.github.raw+json',
              Authorization: `Bearer ${t}`,
              'User-Agent': 'Project-X',
              'X-GitHub-Api-Version': '2022-11-28',
            },
            // Review cancellation / deadline aborts in-flight reads, not only the timeout.
            signal: signal
              ? AbortSignal.any([AbortSignal.timeout(GITHUB_TIMEOUT_MS), signal])
              : AbortSignal.timeout(GITHUB_TIMEOUT_MS),
          });
          if (!response.ok) return null;
          const length = Number(response.headers.get('content-length') ?? '0');
          if (length > MAX_CONTEXT_FILE_BYTES) return null;
          const text = await response.text();
          return text.length > MAX_CONTEXT_FILE_BYTES || text.includes('\u0000') ? null : text;
        } catch {
          return null;
        }
      })();
      cache.set(path, load);
      return load;
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
