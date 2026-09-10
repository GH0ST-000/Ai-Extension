import { createHash, randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import type {
  ApplyPullRequestPatchRequest,
  ApplyPullRequestPatchResponse,
  PreparePullRequestPatchRequest,
  PreparePullRequestPatchResponse,
} from '@project-x/types';
import {
  GITHUB_PATCH_MAX_COMMIT_MESSAGE_CHARACTERS,
  GITHUB_PATCH_MAX_FILE_BYTES,
  GITHUB_PATCH_PREPARE_TTL_SECONDS,
} from '@project-x/types';

import { RedisService } from '../redis/redis.service';
import { GithubConnectionService } from '../settings/github-connection.service';
import { GithubErrorNormalizer } from './github-error-normalizer';
import { countLineDiff, normalizeRepositoryPath } from './patch-path';

const IDEMPOTENCY_TTL_SECONDS = 60 * 60 * 24;
const LOCK_TTL_SECONDS = 45;

type GitHubPullResponse = {
  number?: number;
  state?: string;
  merged?: boolean;
  html_url?: string;
  head?: {
    sha?: string;
    ref?: string;
    repo?: { full_name?: string; name?: string; owner?: { login?: string } } | null;
  };
  base?: {
    ref?: string;
    repo?: { full_name?: string; name?: string; owner?: { login?: string } } | null;
  };
  message?: string;
};

type GitHubContentResponse = {
  type?: string;
  encoding?: string;
  content?: string;
  sha?: string;
  size?: number;
  message?: string;
  html_url?: string;
  commit?: { sha?: string; html_url?: string };
};

type StoredPreparation = {
  preparedPatchId: string;
  userId: string;
  owner: string;
  repository: string;
  pullRequestNumber: number;
  headOwner: string;
  headRepository: string;
  headRef: string;
  expectedHeadSha: string;
  baseOwner: string;
  baseRepository: string;
  baseRef: string;
  path: string;
  expectedBlobSha: string;
  originalContent: string;
  newContent: string;
  fingerprint: string;
  defaultCommitMessage: string;
  findingId?: string;
  createdAt: string;
  expiresAt: string;
};

type CachedApplyResult = Omit<ApplyPullRequestPatchResponse, 'deduplicated'>;

type IdempotencyRecord =
  | { kind: 'success'; fingerprint: string; result: CachedApplyResult }
  | { kind: 'lock'; fingerprint: string };

@Injectable()
export class GithubPatchService {
  constructor(
    private readonly githubConnections: GithubConnectionService,
    private readonly redis: RedisService,
    private readonly errors: GithubErrorNormalizer,
  ) {}

  async preparePullRequestPatch(
    userId: string,
    ownerRaw: string,
    repositoryRaw: string,
    pullRequestNumber: number,
    input: PreparePullRequestPatchRequest,
  ): Promise<PreparePullRequestPatchResponse> {
    const owner = ownerRaw.trim();
    const repository = repositoryRaw.trim();
    this.assertIdentity(owner, repository, pullRequestNumber);

    const path = normalizeRepositoryPath(input.path);
    if (!path) {
      throw this.errors.toHttpException(
        'PATCH_INVALID',
        'File path is invalid. Absolute paths and path traversal are not allowed.',
      );
    }

    if (Buffer.byteLength(input.newContent, 'utf8') > GITHUB_PATCH_MAX_FILE_BYTES) {
      throw this.errors.toHttpException(
        'PATCH_INVALID',
        `newContent exceeds ${GITHUB_PATCH_MAX_FILE_BYTES} bytes.`,
      );
    }

    const token = await this.requireToken(userId);
    const pull = await this.fetchPullRequest({ token, owner, repository, pullRequestNumber });
    if (pull.state !== 'open' || pull.merged) {
      throw this.errors.toHttpException(
        'PULL_REQUEST_NOT_FOUND',
        'This pull request is closed or merged. Refresh before applying a fix.',
      );
    }

    const headOwner = pull.head?.repo?.owner?.login?.trim();
    const headRepository = pull.head?.repo?.name?.trim();
    const headRef = pull.head?.ref?.trim();
    const expectedHeadSha = pull.head?.sha?.trim();
    const baseOwner = pull.base?.repo?.owner?.login?.trim() || owner;
    const baseRepository = pull.base?.repo?.name?.trim() || repository;
    const baseRef = pull.base?.ref?.trim() || '';

    if (!headOwner || !headRepository || !headRef || !expectedHeadSha) {
      throw this.errors.toHttpException(
        'PATCH_UNSUPPORTED',
        'Could not resolve the pull request head repository/branch/SHA.',
      );
    }

    const file = await this.fetchFileContent({
      token,
      owner: headOwner,
      repository: headRepository,
      path,
      ref: expectedHeadSha,
    });

    if (file.type && file.type !== 'file') {
      throw this.errors.toHttpException(
        'PATCH_UNSUPPORTED',
        'Only regular text files can be updated in Day 14 Apply Fix.',
      );
    }

    if (!file.sha || typeof file.content !== 'string') {
      throw this.errors.toHttpException(
        'PATCH_CONFLICT',
        'Could not load the current file version for this path on the PR head.',
      );
    }

    if ((file.size ?? 0) > GITHUB_PATCH_MAX_FILE_BYTES) {
      throw this.errors.toHttpException(
        'PATCH_UNSUPPORTED',
        'Target file is too large for Day 14 Apply Fix.',
      );
    }

    let originalContent: string;
    try {
      originalContent = Buffer.from(file.content, 'base64').toString('utf8');
    } catch {
      throw this.errors.toHttpException(
        'PATCH_UNSUPPORTED',
        'Target file content could not be decoded as text.',
      );
    }

    if (originalContent.includes('\u0000') || input.newContent.includes('\u0000')) {
      throw this.errors.toHttpException(
        'PATCH_UNSUPPORTED',
        'Binary file modifications are not supported in Day 14.',
      );
    }

    if (originalContent === input.newContent) {
      throw this.errors.toHttpException(
        'PATCH_INVALID',
        'The proposed fix does not change the current file content.',
      );
    }

    const commitMessage = this.normalizeCommitMessage(input.commitMessage || `fix: update ${path}`);
    const preparedPatchId = randomUUID();
    const fingerprint = this.buildPreparationFingerprint({
      owner,
      repository,
      pullRequestNumber,
      headOwner,
      headRepository,
      headRef,
      expectedHeadSha,
      path,
      expectedBlobSha: file.sha,
      newContent: input.newContent,
    });

    const now = new Date();
    const expiresAt = new Date(now.getTime() + GITHUB_PATCH_PREPARE_TTL_SECONDS * 1000);
    const stored: StoredPreparation = {
      preparedPatchId,
      userId,
      owner,
      repository,
      pullRequestNumber,
      headOwner,
      headRepository,
      headRef,
      expectedHeadSha,
      baseOwner,
      baseRepository,
      baseRef,
      path,
      expectedBlobSha: file.sha,
      originalContent,
      newContent: input.newContent,
      fingerprint,
      defaultCommitMessage: commitMessage,
      findingId: input.findingId,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };

    await this.storePreparation(userId, preparedPatchId, stored);

    const stats = countLineDiff(originalContent, input.newContent);
    return {
      preparedPatchId,
      owner,
      repository,
      headOwner,
      headRepository,
      pullRequestNumber,
      headRef,
      expectedHeadSha,
      baseOwner,
      baseRepository,
      baseRef,
      files: [
        {
          path,
          operation: 'modify',
          expectedBlobSha: file.sha,
          originalContent,
          newContent: input.newContent,
          additions: stats.additions,
          deletions: stats.deletions,
        },
      ],
      commitMessage,
      fingerprint,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async applyPullRequestPatch(
    userId: string,
    ownerRaw: string,
    repositoryRaw: string,
    pullRequestNumber: number,
    input: ApplyPullRequestPatchRequest,
  ): Promise<ApplyPullRequestPatchResponse> {
    const owner = ownerRaw.trim();
    const repository = repositoryRaw.trim();
    this.assertIdentity(owner, repository, pullRequestNumber);

    const commitMessage = this.normalizeCommitMessage(input.commitMessage);
    const preparedPatchId = input.preparedPatchId.trim();
    const clientRequestId = input.clientRequestId.trim();

    const preparation = await this.readPreparation(userId, preparedPatchId);
    if (!preparation) {
      throw this.errors.toHttpException(
        'PATCH_INVALID',
        'Prepared patch not found or expired. Prepare the fix again before applying it.',
      );
    }

    if (
      preparation.owner !== owner ||
      preparation.repository !== repository ||
      preparation.pullRequestNumber !== pullRequestNumber
    ) {
      throw this.errors.toHttpException(
        'PATCH_INVALID',
        'Prepared patch does not match this pull request.',
      );
    }

    if (new Date(preparation.expiresAt).getTime() < Date.now()) {
      throw this.errors.toHttpException(
        'PATCH_INVALID',
        'Prepared patch expired. Prepare the fix again before applying it.',
      );
    }

    const writeFingerprint = this.buildApplyFingerprint({
      preparedPatchId,
      preparationFingerprint: preparation.fingerprint,
      commitMessage,
      expectedHeadSha: preparation.expectedHeadSha,
      path: preparation.path,
      newContent: preparation.newContent,
    });

    const cacheKey = `gh:pr-patch:${userId}:${clientRequestId}`;
    const lockKey = `${cacheKey}:lock`;

    const existing = await this.readIdempotentRecord(cacheKey);
    if (existing?.kind === 'success') {
      if (existing.fingerprint !== writeFingerprint) {
        throw this.errors.toHttpException(
          'IDEMPOTENCY_CONFLICT',
          'This clientRequestId was already used with a different patch payload.',
        );
      }
      return { ...existing.result, deduplicated: true };
    }

    const lockAcquired = await this.acquireLock(lockKey, writeFingerprint);
    if (!lockAcquired) {
      const raced = await this.waitForSuccess(cacheKey, writeFingerprint);
      if (raced) {
        return { ...raced, deduplicated: true };
      }
      throw this.errors.toHttpException(
        'WRITE_OUTCOME_UNKNOWN',
        'A patch application may already be in progress. Check the pull request before retrying.',
      );
    }

    try {
      const afterLock = await this.readIdempotentRecord(cacheKey);
      if (afterLock?.kind === 'success') {
        if (afterLock.fingerprint !== writeFingerprint) {
          throw this.errors.toHttpException(
            'IDEMPOTENCY_CONFLICT',
            'This clientRequestId was already used with a different patch payload.',
          );
        }
        return { ...afterLock.result, deduplicated: true };
      }

      const token = await this.requireToken(userId);
      const pull = await this.fetchPullRequest({
        token,
        owner,
        repository,
        pullRequestNumber,
      });

      const currentHeadSha = pull.head?.sha?.trim();
      if (!currentHeadSha) {
        throw this.errors.toHttpException(
          'PATCH_UNSUPPORTED',
          'Could not resolve the current pull request head SHA.',
        );
      }
      if (currentHeadSha !== preparation.expectedHeadSha) {
        throw this.errors.toHttpException(
          'PR_HEAD_CHANGED',
          'The pull request changed after this fix was prepared. Prepare the fix again before applying it.',
        );
      }

      const headOwner = pull.head?.repo?.owner?.login?.trim() || preparation.headOwner;
      const headRepository = pull.head?.repo?.name?.trim() || preparation.headRepository;
      const headRef = pull.head?.ref?.trim() || preparation.headRef;

      if (
        headOwner !== preparation.headOwner ||
        headRepository !== preparation.headRepository ||
        headRef !== preparation.headRef
      ) {
        throw this.errors.toHttpException(
          'PR_HEAD_CHANGED',
          'The pull request head repository/branch changed after preparation.',
        );
      }

      // Re-check file blob before write
      const file = await this.fetchFileContent({
        token,
        owner: headOwner,
        repository: headRepository,
        path: preparation.path,
        ref: currentHeadSha,
      });
      if (!file.sha || file.sha !== preparation.expectedBlobSha) {
        throw this.errors.toHttpException(
          'FILE_CHANGED',
          'The target file changed after this fix was prepared.',
        );
      }

      let result: CachedApplyResult;
      try {
        result = await this.commitFileUpdate({
          token,
          owner: headOwner,
          repository: headRepository,
          path: preparation.path,
          branch: headRef,
          expectedBlobSha: preparation.expectedBlobSha,
          newContent: preparation.newContent,
          commitMessage,
        });
      } catch (error) {
        if (error instanceof TypeError) {
          throw this.errors.toHttpException(
            'WRITE_OUTCOME_UNKNOWN',
            'Connection failed while applying the fix. The change may already exist on GitHub — check the PR before retrying.',
          );
        }
        throw error;
      }

      await this.storeIdempotentSuccess(cacheKey, writeFingerprint, result);
      await this.deletePreparation(userId, preparedPatchId);
      return { ...result, deduplicated: false };
    } finally {
      await this.releaseLock(lockKey);
    }
  }

  private assertIdentity(owner: string, repository: string, pullRequestNumber: number): void {
    if (
      !owner ||
      !repository ||
      pullRequestNumber < 1 ||
      owner === 'unknown' ||
      repository === 'unknown'
    ) {
      throw this.errors.toHttpException(
        'PATCH_INVALID',
        'Missing GitHub PR identity. Open the PR page and regenerate the fix.',
      );
    }
  }

  private async requireToken(userId: string): Promise<string> {
    const token = await this.githubConnections.getDecryptedToken(userId);
    if (!token) {
      throw this.errors.toHttpException(
        'NOT_CONNECTED',
        'Connect a GitHub token in dashboard Settings before applying a fix.',
      );
    }
    return token;
  }

  private normalizeCommitMessage(raw: string): string {
    const message = raw.trim();
    if (!message) {
      throw this.errors.toHttpException(
        'COMMIT_VALIDATION_FAILED',
        'Commit message must not be empty.',
      );
    }
    if (message.length > GITHUB_PATCH_MAX_COMMIT_MESSAGE_CHARACTERS) {
      throw this.errors.toHttpException(
        'COMMIT_VALIDATION_FAILED',
        `Commit message exceeds ${GITHUB_PATCH_MAX_COMMIT_MESSAGE_CHARACTERS} characters.`,
      );
    }
    return message;
  }

  private buildPreparationFingerprint(input: {
    owner: string;
    repository: string;
    pullRequestNumber: number;
    headOwner: string;
    headRepository: string;
    headRef: string;
    expectedHeadSha: string;
    path: string;
    expectedBlobSha: string;
    newContent: string;
  }): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          ...input,
          owner: input.owner.toLowerCase(),
          repository: input.repository.toLowerCase(),
          headOwner: input.headOwner.toLowerCase(),
          headRepository: input.headRepository.toLowerCase(),
        }),
      )
      .digest('hex');
  }

  private buildApplyFingerprint(input: {
    preparedPatchId: string;
    preparationFingerprint: string;
    commitMessage: string;
    expectedHeadSha: string;
    path: string;
    newContent: string;
  }): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          preparedPatchId: input.preparedPatchId,
          preparationFingerprint: input.preparationFingerprint,
          commitMessage: input.commitMessage,
          expectedHeadSha: input.expectedHeadSha,
          path: input.path,
          newContentHash: createHash('sha256').update(input.newContent).digest('hex'),
        }),
      )
      .digest('hex');
  }

  private githubHeaders(token: string): Record<string, string> {
    return {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'Project-X',
      'X-GitHub-Api-Version': '2022-11-28',
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
        'Unable to reach GitHub to validate the pull request.',
      );
    }
    const payload = (await response.json().catch(() => ({}))) as GitHubPullResponse;
    if (!response.ok) {
      throw this.errors.fromGitHubStatus(response.status, payload.message, 'patch');
    }
    return payload;
  }

  private async fetchFileContent(input: {
    token: string;
    owner: string;
    repository: string;
    path: string;
    ref: string;
  }): Promise<GitHubContentResponse> {
    const url = `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/contents/${input.path
      .split('/')
      .map(encodeURIComponent)
      .join('/')}?ref=${encodeURIComponent(input.ref)}`;

    let response: Response;
    try {
      response = await fetch(url, { method: 'GET', headers: this.githubHeaders(input.token) });
    } catch {
      throw this.errors.toHttpException(
        'GITHUB_UNAVAILABLE',
        'Unable to reach GitHub to load the target file.',
      );
    }

    const payload = (await response.json().catch(() => ({}))) as GitHubContentResponse;
    if (response.status === 404) {
      throw this.errors.toHttpException(
        'PATCH_CONFLICT',
        'This patch no longer applies cleanly — the target file was not found on the PR head.',
      );
    }
    if (!response.ok) {
      throw this.errors.fromGitHubStatus(response.status, payload.message, 'patch');
    }
    return payload;
  }

  private async commitFileUpdate(input: {
    token: string;
    owner: string;
    repository: string;
    path: string;
    branch: string;
    expectedBlobSha: string;
    newContent: string;
    commitMessage: string;
  }): Promise<CachedApplyResult> {
    const url = `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/contents/${input.path
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'PUT',
        headers: {
          ...this.githubHeaders(input.token),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: input.commitMessage,
          content: Buffer.from(input.newContent, 'utf8').toString('base64'),
          sha: input.expectedBlobSha,
          branch: input.branch,
        }),
      });
    } catch {
      throw this.errors.toHttpException(
        'WRITE_OUTCOME_UNKNOWN',
        'Connection failed while applying the fix. The change may already exist on GitHub — check the PR before retrying.',
      );
    }

    const payload = (await response.json().catch(() => ({}))) as GitHubContentResponse;
    if (!response.ok) {
      throw this.errors.fromGitHubStatus(response.status, payload.message, 'patch');
    }

    const commitSha = payload.commit?.sha;
    const commitUrl = payload.commit?.html_url;
    if (typeof commitSha !== 'string' || typeof commitUrl !== 'string') {
      throw this.errors.toHttpException(
        'WRITE_OUTCOME_UNKNOWN',
        'Unexpected GitHub commit response. Check the pull request before retrying.',
      );
    }
    if (!this.isTrustedGithubUrl(commitUrl)) {
      throw this.errors.toHttpException('UNKNOWN', 'GitHub returned an untrusted commit URL.');
    }

    return {
      success: true,
      commitSha,
      commitUrl,
      branch: input.branch,
      appliedAt: new Date().toISOString(),
      changedFiles: 1,
    };
  }

  private isTrustedGithubUrl(url: string): boolean {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'https:' && parsed.hostname === 'github.com';
    } catch {
      return false;
    }
  }

  private async ensureRedis(): Promise<void> {
    if (this.redis.status === 'wait') {
      await this.redis.connect();
    }
  }

  private preparationKey(userId: string, preparedPatchId: string): string {
    return `gh:pr-patch-prep:${userId}:${preparedPatchId}`;
  }

  private async storePreparation(
    userId: string,
    preparedPatchId: string,
    stored: StoredPreparation,
  ): Promise<void> {
    try {
      await this.ensureRedis();
      await this.redis.set(
        this.preparationKey(userId, preparedPatchId),
        JSON.stringify(stored),
        'EX',
        GITHUB_PATCH_PREPARE_TTL_SECONDS,
      );
    } catch {
      throw this.errors.toHttpException(
        'GITHUB_UNAVAILABLE',
        'Unable to store the prepared patch. Ensure Redis is available and try again.',
      );
    }
  }

  private async readPreparation(
    userId: string,
    preparedPatchId: string,
  ): Promise<StoredPreparation | null> {
    try {
      await this.ensureRedis();
      const raw = await this.redis.get(this.preparationKey(userId, preparedPatchId));
      if (!raw) {
        return null;
      }
      return JSON.parse(raw) as StoredPreparation;
    } catch {
      return null;
    }
  }

  private async deletePreparation(userId: string, preparedPatchId: string): Promise<void> {
    try {
      await this.ensureRedis();
      await this.redis.del(this.preparationKey(userId, preparedPatchId));
    } catch {
      // ignore
    }
  }

  private async readIdempotentRecord(cacheKey: string): Promise<IdempotencyRecord | null> {
    try {
      await this.ensureRedis();
      const raw = await this.redis.get(cacheKey);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw) as IdempotencyRecord;
      if (parsed.kind === 'success' && parsed.result?.success === true) {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }

  private async storeIdempotentSuccess(
    cacheKey: string,
    fingerprint: string,
    result: CachedApplyResult,
  ): Promise<void> {
    try {
      await this.ensureRedis();
      const record: IdempotencyRecord = { kind: 'success', fingerprint, result };
      await this.redis.set(cacheKey, JSON.stringify(record), 'EX', IDEMPOTENCY_TTL_SECONDS);
    } catch {
      // best-effort
    }
  }

  private async acquireLock(lockKey: string, fingerprint: string): Promise<boolean> {
    try {
      await this.ensureRedis();
      const result = await this.redis.set(lockKey, fingerprint, 'EX', LOCK_TTL_SECONDS, 'NX');
      return result === 'OK';
    } catch {
      return true;
    }
  }

  private async releaseLock(lockKey: string): Promise<void> {
    try {
      await this.ensureRedis();
      await this.redis.del(lockKey);
    } catch {
      // ignore
    }
  }

  private async waitForSuccess(
    cacheKey: string,
    fingerprint: string,
  ): Promise<CachedApplyResult | null> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const record = await this.readIdempotentRecord(cacheKey);
      if (record?.kind === 'success') {
        if (record.fingerprint !== fingerprint) {
          throw this.errors.toHttpException(
            'IDEMPOTENCY_CONFLICT',
            'This clientRequestId was already used with a different patch payload.',
          );
        }
        return record.result;
      }
    }
    return null;
  }
}
