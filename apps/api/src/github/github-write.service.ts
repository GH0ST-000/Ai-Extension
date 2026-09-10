import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type {
  PostPullRequestCommentRequest,
  PostPullRequestCommentResponse,
} from '@project-x/types';

import { RedisService } from '../redis/redis.service';
import { GithubConnectionService } from '../settings/github-connection.service';

const IDEMPOTENCY_TTL_SECONDS = 60 * 60 * 24; // 24h

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

    const cacheKey = `gh:pr-comment:${userId}:${idempotencyKey}`;
    const cached = await this.readIdempotentResult(cacheKey);
    if (cached) {
      return { ...cached, deduplicated: true };
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

    await this.storeIdempotentResult(cacheKey, result);
    return { ...result, deduplicated: false };
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
      throw new ServiceUnavailableException('Unable to reach GitHub to post the comment.');
    }

    const payload = (await response.json().catch(() => ({}))) as GitHubCommentResponse;

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
      throw new ServiceUnavailableException('Unexpected GitHub comment response.');
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

  private async readIdempotentResult(
    cacheKey: string,
  ): Promise<Omit<PostPullRequestCommentResponse, 'deduplicated'> | null> {
    try {
      await this.ensureRedis();
      const raw = await this.redis.get(cacheKey);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw) as Partial<PostPullRequestCommentResponse>;
      if (
        parsed.success === true &&
        typeof parsed.commentId === 'number' &&
        typeof parsed.commentUrl === 'string'
      ) {
        return {
          success: true,
          commentId: parsed.commentId,
          commentUrl: parsed.commentUrl,
        };
      }
      return null;
    } catch {
      // Idempotency is best-effort — never block posting if Redis is down.
      return null;
    }
  }

  private async storeIdempotentResult(
    cacheKey: string,
    result: Omit<PostPullRequestCommentResponse, 'deduplicated'>,
  ): Promise<void> {
    try {
      await this.ensureRedis();
      await this.redis.set(cacheKey, JSON.stringify(result), 'EX', IDEMPOTENCY_TTL_SECONDS, 'NX');
    } catch {
      // Best-effort only.
    }
  }
}
