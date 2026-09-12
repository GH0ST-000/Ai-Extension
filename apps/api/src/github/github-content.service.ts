import { HttpException, Injectable } from '@nestjs/common';
import type { GitHubFileVersionsRequest, GitHubFileVersionsResponse } from '@project-x/types';
import { GITHUB_PATCH_MAX_FILE_BYTES } from '@project-x/types';

import { GithubConnectionService } from '../settings/github-connection.service';
import { GithubErrorNormalizer } from './github-error-normalizer';
import { normalizeRepositoryPath } from './patch-path';

type GitHubContentResponse = {
  type?: string;
  encoding?: string;
  content?: string;
  sha?: string;
  size?: number;
  message?: string;
};

type GitHubPullResponse = {
  number?: number;
  head?: { sha?: string };
  base?: { sha?: string };
  message?: string;
};

/**
 * Read-only GitHub Contents helpers for Day 18 OpenAPI PR diffs.
 * Reuses the same PAT + Contents API pattern as patch prepare (no writes).
 */
@Injectable()
export class GithubContentService {
  constructor(
    private readonly githubConnections: GithubConnectionService,
    private readonly errors: GithubErrorNormalizer,
  ) {}

  /**
   * Resolve base + head SHAs for a pull request (trusted live PR object).
   */
  async resolvePullRequestShas(
    userId: string,
    ownerRaw: string,
    repositoryRaw: string,
    pullRequestNumber: number,
  ): Promise<{ owner: string; repository: string; baseSha: string; headSha: string }> {
    const owner = ownerRaw.trim();
    const repository = repositoryRaw.trim();
    this.assertRepoIdentity(owner, repository);
    if (pullRequestNumber < 1) {
      throw this.errors.toHttpException(
        'PULL_REQUEST_NOT_FOUND',
        'pullRequestNumber must be a positive integer.',
      );
    }

    const token = await this.requireToken(userId);
    const pull = await this.fetchPullRequest({ token, owner, repository, pullRequestNumber });
    const baseSha = pull.base?.sha?.trim();
    const headSha = pull.head?.sha?.trim();
    if (!baseSha || !headSha) {
      throw this.errors.toHttpException(
        'PULL_REQUEST_NOT_FOUND',
        'GitHub did not return base/head SHAs for this pull request.',
      );
    }
    return { owner, repository, baseSha, headSha };
  }

  async fetchFileVersions(
    userId: string,
    ownerRaw: string,
    repositoryRaw: string,
    input: GitHubFileVersionsRequest,
  ): Promise<GitHubFileVersionsResponse> {
    const owner = ownerRaw.trim();
    const repository = repositoryRaw.trim();
    this.assertRepoIdentity(owner, repository);

    const path = normalizeRepositoryPath(input.path);
    if (!path) {
      throw this.errors.toHttpException(
        'PATCH_INVALID',
        'File path is invalid. Absolute paths and path traversal are not allowed.',
      );
    }

    const baseSha = input.baseSha.trim().toLowerCase();
    const headSha = input.headSha.trim().toLowerCase();
    if (!/^[0-9a-f]{7,64}$/.test(baseSha) || !/^[0-9a-f]{7,64}$/.test(headSha)) {
      throw this.errors.toHttpException('PATCH_INVALID', 'baseSha and headSha must be git SHAs.');
    }

    const token = await this.requireToken(userId);
    const [baseContent, headContent] = await Promise.all([
      this.fetchTextFileAtRef({ token, owner, repository, path, ref: baseSha }),
      this.fetchTextFileAtRef({ token, owner, repository, path, ref: headSha }),
    ]);

    return {
      owner,
      repository,
      path,
      baseSha,
      headSha,
      baseContent,
      headContent,
      basePresent: baseContent != null,
      headPresent: headContent != null,
    };
  }

  /**
   * Convenience: resolve PR base/head SHAs then fetch both file versions.
   */
  async fetchPullRequestFileVersions(
    userId: string,
    ownerRaw: string,
    repositoryRaw: string,
    pullRequestNumber: number,
    pathRaw: string,
  ): Promise<GitHubFileVersionsResponse & { pullRequestNumber: number }> {
    const shas = await this.resolvePullRequestShas(
      userId,
      ownerRaw,
      repositoryRaw,
      pullRequestNumber,
    );
    const versions = await this.fetchFileVersions(userId, shas.owner, shas.repository, {
      path: pathRaw,
      baseSha: shas.baseSha,
      headSha: shas.headSha,
    });
    return { ...versions, pullRequestNumber };
  }

  /**
   * Fetch a single UTF-8 file at a ref (default branch when ref is omitted/empty).
   * Returns null when the path is missing (404) or not a file.
   */
  async fetchRepositoryFileAtRef(
    userId: string,
    ownerRaw: string,
    repositoryRaw: string,
    pathRaw: string,
    ref?: string,
  ): Promise<string | null> {
    const owner = ownerRaw.trim();
    const repository = repositoryRaw.trim();
    this.assertRepoIdentity(owner, repository);

    const path = normalizeRepositoryPath(pathRaw);
    if (!path) {
      return null;
    }

    const token = await this.requireToken(userId);
    const refTrimmed = typeof ref === 'string' ? ref.trim() : '';
    try {
      return await this.fetchTextFileAtRef({
        token,
        owner,
        repository,
        path,
        ...(refTrimmed ? { ref: refTrimmed } : {}),
      });
    } catch (err) {
      // Treat non-file / unsupported paths as missing for read helpers (e.g. learn).
      if (err instanceof HttpException) {
        const body = err.getResponse();
        if (
          body &&
          typeof body === 'object' &&
          'code' in body &&
          (body as { code?: string }).code === 'PATCH_UNSUPPORTED'
        ) {
          return null;
        }
      }
      throw err;
    }
  }

  private assertRepoIdentity(owner: string, repository: string): void {
    if (!owner || !repository || owner === 'unknown' || repository === 'unknown') {
      throw this.errors.toHttpException('PATCH_INVALID', 'owner and repository are required.');
    }
  }

  private async requireToken(userId: string): Promise<string> {
    const token = await this.githubConnections.getDecryptedToken(userId);
    if (!token) {
      throw this.errors.toHttpException(
        'NOT_CONNECTED',
        'Connect a GitHub token in dashboard Settings before reading repository files.',
      );
    }
    return token;
  }

  private githubHeaders(token: string): Record<string, string> {
    return {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Project-X',
    };
  }

  private async fetchPullRequest(input: {
    token: string;
    owner: string;
    repository: string;
    pullRequestNumber: number;
  }): Promise<GitHubPullResponse> {
    const url = `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/pulls/${input.pullRequestNumber}`;
    let response: Response;
    try {
      response = await fetch(url, { method: 'GET', headers: this.githubHeaders(input.token) });
    } catch {
      throw this.errors.toHttpException(
        'GITHUB_UNAVAILABLE',
        'Unable to reach GitHub to resolve the pull request.',
      );
    }
    const payload = (await response.json().catch(() => ({}))) as GitHubPullResponse;
    if (!response.ok) {
      throw this.errors.fromGitHubStatus(response.status, payload.message, 'patch');
    }
    return payload;
  }

  /**
   * Returns UTF-8 file text, or null when the path is missing at ref (404).
   * When `ref` is omitted, GitHub Contents API uses the repository default branch.
   * Throws for directories, oversized blobs, or non-text encodings.
   */
  private async fetchTextFileAtRef(input: {
    token: string;
    owner: string;
    repository: string;
    path: string;
    ref?: string;
  }): Promise<string | null> {
    const encodedPath = input.path.split('/').map(encodeURIComponent).join('/');
    const base = `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/contents/${encodedPath}`;
    const url =
      input.ref && input.ref.trim() ? `${base}?ref=${encodeURIComponent(input.ref.trim())}` : base;

    let response: Response;
    try {
      response = await fetch(url, { method: 'GET', headers: this.githubHeaders(input.token) });
    } catch {
      throw this.errors.toHttpException(
        'GITHUB_UNAVAILABLE',
        'Unable to reach GitHub to load the file.',
      );
    }

    if (response.status === 404) {
      return null;
    }

    const payload = (await response.json().catch(() => ({}))) as GitHubContentResponse;
    if (!response.ok) {
      throw this.errors.fromGitHubStatus(response.status, payload.message, 'patch');
    }

    if (payload.type && payload.type !== 'file') {
      throw this.errors.toHttpException(
        'PATCH_UNSUPPORTED',
        'Path does not point to a file at that commit.',
      );
    }

    if (typeof payload.size === 'number' && payload.size > GITHUB_PATCH_MAX_FILE_BYTES) {
      throw this.errors.toHttpException(
        'PATCH_UNSUPPORTED',
        `File exceeds ${GITHUB_PATCH_MAX_FILE_BYTES} bytes.`,
      );
    }

    if (payload.encoding && payload.encoding !== 'base64') {
      throw this.errors.toHttpException(
        'PATCH_UNSUPPORTED',
        'Unexpected GitHub content encoding for this file.',
      );
    }

    if (typeof payload.content !== 'string') {
      throw this.errors.toHttpException(
        'PATCH_UNSUPPORTED',
        'GitHub did not return file content for this path.',
      );
    }

    let text: string;
    try {
      text = Buffer.from(payload.content.replace(/\n/g, ''), 'base64').toString('utf8');
    } catch {
      throw this.errors.toHttpException(
        'PATCH_UNSUPPORTED',
        'File content could not be decoded as text.',
      );
    }

    if (Buffer.byteLength(text, 'utf8') > GITHUB_PATCH_MAX_FILE_BYTES) {
      throw this.errors.toHttpException(
        'PATCH_UNSUPPORTED',
        `Decoded file exceeds ${GITHUB_PATCH_MAX_FILE_BYTES} bytes.`,
      );
    }
    return text;
  }
}
