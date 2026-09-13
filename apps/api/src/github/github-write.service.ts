import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type {
  PostPullRequestCommentRequest,
  PostPullRequestCommentResponse,
} from '@project-x/types';

import { RedisService } from '../redis/redis.service';
import { GithubConnectionService } from '../settings/github-connection.service';
import { GithubErrorNormalizer } from './github-error-normalizer';

const IDEMPOTENCY_TTL_SECONDS = 60 * 60 * 24; // 24h
const LOCK_TTL_SECONDS = 30;

type GitHubCommentResponse = {
  id?: number;
  html_url?: string;
  message?: string;
  documentation_url?: string;
};

@Injectable()
export class GithubWriteService {
  constructor(
    private readonly githubConnections: GithubConnectionService,
    private readonly redis: RedisService,
    private readonly errors: GithubErrorNormalizer,
  ) {}

  async postPullRequestComment(
    userId: string,
    input: PostPullRequestCommentRequest,
  ): Promise<PostPullRequestCommentResponse> {
    const owner = input.owner.trim();
    const repository = input.repository.trim();
    const body = input.body.trim();
    const idempotencyKey = input.idempotencyKey.trim();

    if (!owner || !repository || !body || !idempotencyKey) {
      throw new BadRequestException('owner, repository, body, and idempotencyKey are required.');
    }

    if (owner === 'unknown' || repository === 'unknown' || input.pullRequestNumber < 1) {
      throw new BadRequestException(
        'Missing GitHub PR identity. Open the PR page and run Review Entire PR again.',
      );
    }

    if (Buffer.byteLength(body, 'utf8') > 65_536) {
      throw new BadRequestException('Comment body exceeds the maximum allowed size.');
    }

    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          owner,
          repository,
          pullRequestNumber: input.pullRequestNumber,
          body,
        }),
      )
      .digest('hex');

    const cacheKey = `gh:pr-comment:${userId}:${idempotencyKey}`;
    const lockKey = `${cacheKey}:lock`;

    const cached = await this.readIdempotentResult(cacheKey);
    if (cached) {
      if (cached.fingerprint !== fingerprint) {
        throw this.errors.toHttpException(
          'IDEMPOTENCY_CONFLICT',
          'This idempotencyKey was already used with a different comment payload.',
        );
      }
      return { ...cached.result, deduplicated: true };
    }

    const lockAcquired = await this.acquireLock(lockKey, fingerprint);
    if (!lockAcquired) {
      const raced = await this.readIdempotentResult(cacheKey);
      if (raced && raced.fingerprint === fingerprint) {
        return { ...raced.result, deduplicated: true };
      }
      throw this.errors.toHttpException(
        'WRITE_OUTCOME_UNKNOWN',
        'A comment may already be posting for this request. Check GitHub before retrying.',
      );
    }

    try {
      const afterLock = await this.readIdempotentResult(cacheKey);
      if (afterLock) {
        if (afterLock.fingerprint !== fingerprint) {
          throw this.errors.toHttpException(
            'IDEMPOTENCY_CONFLICT',
            'This idempotencyKey was already used with a different comment payload.',
          );
        }
        return { ...afterLock.result, deduplicated: true };
      }

      const token = await this.githubConnections.getDecryptedToken(userId);
      if (!token) {
        throw new ForbiddenException(
          'Connect a GitHub token in dashboard Settings before posting comments.',
        );
      }

      await this.assertPullRequestOpen({
        token,
        owner,
        repository,
        pullRequestNumber: input.pullRequestNumber,
      });

      const result = await this.createIssueComment({
        token,
        owner,
        repository,
        pullRequestNumber: input.pullRequestNumber,
        body,
      });

      await this.storeIdempotentResult(cacheKey, fingerprint, result);
      return { ...result, deduplicated: false };
    } finally {
      await this.releaseLock(lockKey);
    }
  }

  private async assertPullRequestOpen(input: {
    token: string;
    owner: string;
    repository: string;
    pullRequestNumber: number;
  }): Promise<void> {
    const url = `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/pulls/${input.pullRequestNumber}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${input.token}`,
          'User-Agent': 'Project-X',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
    } catch {
      throw new ServiceUnavailableException('Unable to reach GitHub to validate the pull request.');
    }

    const payload = (await response.json().catch(() => ({}))) as {
      state?: string;
      merged?: boolean;
      message?: string;
    };

    if (response.status === 401) {
      throw new UnauthorizedException(
        'GitHub rejected your stored token. Update it in dashboard Settings.',
      );
    }
    if (response.status === 403) {
      throw new ForbiddenException(
        payload.message?.trim() ||
          'GitHub forbade access to this pull request. Check PAT permissions and org SSO.',
      );
    }
    if (response.status === 404) {
      throw new BadRequestException(
        'GitHub could not find that repository or pull request (or the token cannot access it).',
      );
    }
    if (!response.ok) {
      throw new BadRequestException(
        payload.message?.trim() || `GitHub PR lookup failed (HTTP ${response.status}).`,
      );
    }
    if (payload.state !== 'open' || payload.merged) {
      throw new BadRequestException(
        'This pull request is closed or merged. Refresh the PR page before posting.',
      );
    }
  }

  private async createIssueComment(input: {
    token: string;
    owner: string;
    repository: string;
    pullRequestNumber: number;
    body: string;
  }): Promise<Omit<PostPullRequestCommentResponse, 'deduplicated'>> {
    const url = `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/issues/${input.pullRequestNumber}/comments`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${input.token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'Project-X',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({ body: input.body }),
      });
    } catch {
      throw this.errors.toHttpException(
        'WRITE_OUTCOME_UNKNOWN',
        'The comment request did not complete cleanly. Check GitHub before retrying.',
      );
    }

    let payload: GitHubCommentResponse;
    try {
      payload = (await response.json()) as GitHubCommentResponse;
    } catch {
      throw this.errors.toHttpException(
        'WRITE_OUTCOME_UNKNOWN',
        'GitHub returned an unreadable comment response. Check GitHub before retrying.',
      );
    }

    if (response.status === 401) {
      throw new UnauthorizedException(
        'GitHub rejected your stored token. Update it in dashboard Settings.',
      );
    }

    if (response.status === 403) {
      throw new ForbiddenException(
        payload.message?.trim() ||
          'GitHub forbade posting this comment. Check PAT permissions (Pull requests: Read and write) and org SSO.',
      );
    }

    if (response.status === 404) {
      throw new BadRequestException(
        'GitHub could not find that repository or pull request (or the token cannot access it).',
      );
    }

    if (!response.ok) {
      throw new BadRequestException(
        payload.message?.trim() || `GitHub comment failed (HTTP ${response.status}).`,
      );
    }

    if (typeof payload.id !== 'number' || typeof payload.html_url !== 'string') {
      throw this.errors.toHttpException(
        'WRITE_OUTCOME_UNKNOWN',
        'Unexpected GitHub comment response. Check GitHub before retrying.',
      );
    }

    return {
      success: true,
      commentId: payload.id,
      commentUrl: payload.html_url,
    };
  }

  private async ensureRedis(): Promise<void> {
    if (this.redis.status === 'wait') {
      await this.redis.connect();
    }
  }

  private async acquireLock(lockKey: string, fingerprint: string): Promise<boolean> {
    try {
      await this.ensureRedis();
      const result = await this.redis.set(lockKey, fingerprint, 'EX', LOCK_TTL_SECONDS, 'NX');
      return result === 'OK';
    } catch {
      // Fail closed for concurrent write safety when Redis is down.
      throw this.errors.toHttpException(
        'GITHUB_UNAVAILABLE',
        'Unable to coordinate write safety. Please try again shortly.',
      );
    }
  }

  private async releaseLock(lockKey: string): Promise<void> {
    try {
      await this.ensureRedis();
      await this.redis.del(lockKey);
    } catch {
      // TTL will expire the lock.
    }
  }

  private async readIdempotentResult(cacheKey: string): Promise<{
    fingerprint: string;
    result: Omit<PostPullRequestCommentResponse, 'deduplicated'>;
  } | null> {
    try {
      await this.ensureRedis();
      const raw = await this.redis.get(cacheKey);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw) as {
        fingerprint?: string;
        success?: boolean;
        commentId?: number;
        commentUrl?: string;
      };
      if (
        typeof parsed.fingerprint === 'string' &&
        parsed.success === true &&
        typeof parsed.commentId === 'number' &&
        typeof parsed.commentUrl === 'string'
      ) {
        return {
          fingerprint: parsed.fingerprint,
          result: {
            success: true,
            commentId: parsed.commentId,
            commentUrl: parsed.commentUrl,
          },
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  private async storeIdempotentResult(
    cacheKey: string,
    fingerprint: string,
    result: Omit<PostPullRequestCommentResponse, 'deduplicated'>,
  ): Promise<void> {
    try {
      await this.ensureRedis();
      await this.redis.set(
        cacheKey,
        JSON.stringify({ fingerprint, ...result }),
        'EX',
        IDEMPOTENCY_TTL_SECONDS,
        'NX',
      );
    } catch {
      // Best-effort only after successful write.
    }
  }
}
