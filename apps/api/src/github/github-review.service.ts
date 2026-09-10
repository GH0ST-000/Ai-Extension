import { Injectable } from '@nestjs/common';
import type {
  GitHubReviewEvent,
  SubmitPullRequestReviewRequest,
  SubmitPullRequestReviewResponse,
} from '@project-x/types';
import {
  GITHUB_REVIEW_MAX_BODY_CHARACTERS,
  GITHUB_REVIEW_MAX_COMMENT_CHARACTERS,
  GITHUB_REVIEW_MAX_COMMENTS,
} from '@project-x/types';

import { RedisService } from '../redis/redis.service';
import { GithubConnectionService } from '../settings/github-connection.service';
import { GithubErrorNormalizer } from './github-error-normalizer';
import { reviewRequestFingerprint } from './review-fingerprint';

const IDEMPOTENCY_TTL_SECONDS = 60 * 60 * 24; // 24h
const LOCK_TTL_SECONDS = 30;

type GitHubPullResponse = {
  number?: number;
  state?: string;
  merged?: boolean;
  html_url?: string;
  head?: { sha?: string };
  user?: { login?: string };
  message?: string;
};

type GitHubReviewApiResponse = {
  id?: number;
  state?: string;
  html_url?: string;
  submitted_at?: string;
  body?: string;
  message?: string;
  errors?: Array<{ message?: string }>;
};

type CachedReviewResult = Omit<SubmitPullRequestReviewResponse, 'deduplicated'>;

type IdempotencyRecord =
  | { kind: 'success'; fingerprint: string; result: CachedReviewResult }
  | { kind: 'lock'; fingerprint: string };

@Injectable()
export class GithubReviewService {
  constructor(
    private readonly githubConnections: GithubConnectionService,
    private readonly redis: RedisService,
    private readonly errors: GithubErrorNormalizer,
  ) {}

  async submitPullRequestReview(
    userId: string,
    ownerRaw: string,
    repositoryRaw: string,
    pullRequestNumber: number,
    input: SubmitPullRequestReviewRequest,
  ): Promise<SubmitPullRequestReviewResponse> {
    const owner = ownerRaw.trim();
    const repository = repositoryRaw.trim();
    const clientRequestId = input.clientRequestId.trim();
    const event = input.event;
    const body = (input.body ?? '').trim();
    const comments = (input.comments ?? []).map((comment) => ({
      body: comment.body.trim(),
      path: comment.path?.trim(),
      line: comment.line,
      side: comment.side,
      startLine: comment.startLine,
      startSide: comment.startSide,
    }));

    this.assertIdentity(owner, repository, pullRequestNumber);
    this.validatePayload(event, body, comments);

    const fingerprint = reviewRequestFingerprint(owner, repository, pullRequestNumber, {
      ...input,
      body,
      comments,
      clientRequestId,
      event,
    });

    const cacheKey = `gh:pr-review:${userId}:${clientRequestId}`;
    const lockKey = `${cacheKey}:lock`;

    const existing = await this.readIdempotentRecord(cacheKey);
    if (existing?.kind === 'success') {
      if (existing.fingerprint !== fingerprint) {
        throw this.errors.toHttpException(
          'IDEMPOTENCY_CONFLICT',
          'This clientRequestId was already used with a different review payload.',
        );
      }
      return { ...existing.result, deduplicated: true };
    }

    const lockAcquired = await this.acquireLock(lockKey, fingerprint);
    if (!lockAcquired) {
      // Another in-flight request — wait briefly for success record
      const raced = await this.waitForSuccess(cacheKey, fingerprint);
      if (raced) {
        return { ...raced, deduplicated: true };
      }
      throw this.errors.toHttpException(
        'WRITE_OUTCOME_UNKNOWN',
        'A review submission may already be in progress for this request. Check GitHub before retrying.',
      );
    }

    try {
      const afterLock = await this.readIdempotentRecord(cacheKey);
      if (afterLock?.kind === 'success') {
        if (afterLock.fingerprint !== fingerprint) {
          throw this.errors.toHttpException(
            'IDEMPOTENCY_CONFLICT',
            'This clientRequestId was already used with a different review payload.',
          );
        }
        return { ...afterLock.result, deduplicated: true };
      }

      const token = await this.githubConnections.getDecryptedToken(userId);
      if (!token) {
        throw this.errors.toHttpException(
          'NOT_CONNECTED',
          'Connect a GitHub token in dashboard Settings before submitting a review.',
        );
      }

      const pull = await this.fetchPullRequest({ token, owner, repository, pullRequestNumber });
      if (pull.state !== 'open' || pull.merged) {
        throw this.errors.toHttpException(
          'PULL_REQUEST_NOT_FOUND',
          'This pull request is closed or merged. Refresh the PR page and start a new review draft.',
        );
      }

      const headSha = pull.head?.sha;
      if (input.expectedHeadSha && headSha && input.expectedHeadSha !== headSha) {
        throw this.errors.toHttpException(
          'STALE_DIFF_POSITION',
          'The pull request head changed since this draft was created. Refresh the review before submitting inline comments.',
        );
      }

      const { inlineComments, aggregatedBody } = this.partitionComments(body, comments);

      const result = await this.createPullRequestReview({
        token,
        owner,
        repository,
        pullRequestNumber,
        event,
        body: aggregatedBody,
        commitId: headSha,
        comments: inlineComments,
      });

      await this.storeIdempotentSuccess(cacheKey, fingerprint, {
        ...result,
        commentCount: comments.length,
      });
      return { ...result, commentCount: comments.length, deduplicated: false };
    } finally {
      await this.releaseLock(lockKey);
    }
  }

  private assertIdentity(owner: string, repository: string, pullRequestNumber: number): void {
    if (!owner || !repository || pullRequestNumber < 1) {
      throw this.errors.toHttpException(
        'REVIEW_VALIDATION_FAILED',
        'owner, repository, and pullRequestNumber are required.',
      );
    }
    if (owner === 'unknown' || repository === 'unknown') {
      throw this.errors.toHttpException(
        'REVIEW_VALIDATION_FAILED',
        'Missing GitHub PR identity. Open the PR page and run Review Entire PR again.',
      );
    }
  }

  private validatePayload(
    event: GitHubReviewEvent,
    body: string,
    comments: SubmitPullRequestReviewRequest['comments'],
  ): void {
    if (comments.length > GITHUB_REVIEW_MAX_COMMENTS) {
      throw this.errors.toHttpException(
        'REVIEW_VALIDATION_FAILED',
        `A review may include at most ${GITHUB_REVIEW_MAX_COMMENTS} comments.`,
      );
    }

    if (body.length > GITHUB_REVIEW_MAX_BODY_CHARACTERS) {
      throw this.errors.toHttpException(
        'REVIEW_VALIDATION_FAILED',
        `Review body exceeds ${GITHUB_REVIEW_MAX_BODY_CHARACTERS} characters.`,
      );
    }

    for (const comment of comments) {
      if (!comment.body.trim()) {
        throw this.errors.toHttpException(
          'REVIEW_VALIDATION_FAILED',
          'Review comments must not be empty.',
        );
      }
      if (comment.body.length > GITHUB_REVIEW_MAX_COMMENT_CHARACTERS) {
        throw this.errors.toHttpException(
          'REVIEW_VALIDATION_FAILED',
          `A review comment exceeds ${GITHUB_REVIEW_MAX_COMMENT_CHARACTERS} characters.`,
        );
      }
      const hasLine = comment.line != null;
      const hasSide = comment.side != null;
      const hasPath = Boolean(comment.path?.trim());
      if (hasLine || hasSide) {
        if (!hasLine || !hasSide || !hasPath) {
          throw this.errors.toHttpException(
            'REVIEW_VALIDATION_FAILED',
            'Line-level comments require path, line, and side.',
          );
        }
      }
    }

    const hasContent = body.length > 0 || comments.length > 0;

    if (event === 'COMMENT' && !hasContent) {
      throw this.errors.toHttpException(
        'REVIEW_VALIDATION_FAILED',
        'COMMENT reviews require an overall body or at least one comment.',
      );
    }

    if (event === 'REQUEST_CHANGES' && !hasContent) {
      throw this.errors.toHttpException(
        'REVIEW_VALIDATION_FAILED',
        'REQUEST_CHANGES requires review feedback (body or comments).',
      );
    }

    // APPROVE may be empty when GitHub permits it.
  }

  private partitionComments(
    body: string,
    comments: SubmitPullRequestReviewRequest['comments'],
  ): {
    inlineComments: Array<{
      path: string;
      body: string;
      line: number;
      side: 'LEFT' | 'RIGHT';
      start_line?: number;
      start_side?: 'LEFT' | 'RIGHT';
    }>;
    aggregatedBody: string;
  } {
    const inlineComments: Array<{
      path: string;
      body: string;
      line: number;
      side: 'LEFT' | 'RIGHT';
      start_line?: number;
      start_side?: 'LEFT' | 'RIGHT';
    }> = [];
    const prLevelNotes: Array<{ path?: string; body: string }> = [];

    for (const comment of comments) {
      if (comment.path && comment.line != null && comment.side) {
        inlineComments.push({
          path: comment.path,
          body: comment.body,
          line: comment.line,
          side: comment.side,
          start_line: comment.startLine,
          start_side: comment.startSide,
        });
      } else {
        prLevelNotes.push({ path: comment.path, body: comment.body });
      }
    }

    let aggregatedBody = body;
    if (prLevelNotes.length > 0) {
      const section = [
        '### Additional review notes',
        '',
        ...prLevelNotes.map((note) => {
          const label = note.path ? `\`${note.path}\`` : '_general_';
          return `- ${label}: ${note.body}`;
        }),
      ].join('\n');
      aggregatedBody = aggregatedBody.trim() ? `${aggregatedBody.trim()}\n\n${section}` : section;
    }

    if (aggregatedBody.length > GITHUB_REVIEW_MAX_BODY_CHARACTERS) {
      throw this.errors.toHttpException(
        'REVIEW_VALIDATION_FAILED',
        `Aggregated review body exceeds ${GITHUB_REVIEW_MAX_BODY_CHARACTERS} characters.`,
      );
    }

    return { inlineComments, aggregatedBody };
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
      response = await fetch(url, {
        method: 'GET',
        headers: this.githubHeaders(input.token),
      });
    } catch {
      throw this.errors.toHttpException(
        'GITHUB_UNAVAILABLE',
        'Unable to reach GitHub to validate the pull request.',
      );
    }

    const payload = (await response.json().catch(() => ({}))) as GitHubPullResponse;
    if (!response.ok) {
      throw this.errors.fromGitHubStatus(response.status, payload.message, 'review');
    }
    return payload;
  }

  private async createPullRequestReview(input: {
    token: string;
    owner: string;
    repository: string;
    pullRequestNumber: number;
    event: GitHubReviewEvent;
    body: string;
    commitId?: string;
    comments: Array<{
      path: string;
      body: string;
      line: number;
      side: 'LEFT' | 'RIGHT';
      start_line?: number;
      start_side?: 'LEFT' | 'RIGHT';
    }>;
  }): Promise<CachedReviewResult> {
    const url = `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/pulls/${input.pullRequestNumber}/reviews`;

    const payload: Record<string, unknown> = {
      event: input.event,
      body: input.body || undefined,
      comments: input.comments.length > 0 ? input.comments : undefined,
    };
    if (input.commitId) {
      payload.commit_id = input.commitId;
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          ...this.githubHeaders(input.token),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    } catch {
      throw this.errors.toHttpException(
        'WRITE_OUTCOME_UNKNOWN',
        'Connection failed while submitting the review. It may already exist on GitHub — check before retrying.',
      );
    }

    const data = (await response.json().catch(() => ({}))) as GitHubReviewApiResponse;
    if (!response.ok) {
      const detail =
        data.message ||
        data.errors
          ?.map((entry) => entry.message)
          .filter(Boolean)
          .join('; ') ||
        undefined;
      throw this.errors.fromGitHubStatus(response.status, detail, 'review');
    }

    if (typeof data.id !== 'number' || typeof data.html_url !== 'string') {
      throw this.errors.toHttpException(
        'WRITE_OUTCOME_UNKNOWN',
        'Unexpected GitHub review response. Check the pull request before retrying.',
      );
    }

    if (!this.isTrustedGithubUrl(data.html_url)) {
      throw this.errors.toHttpException('UNKNOWN', 'GitHub returned an untrusted review URL.');
    }

    return {
      success: true,
      reviewId: data.id,
      state: typeof data.state === 'string' ? data.state : input.event.toLowerCase(),
      reviewUrl: data.html_url,
      submittedAt:
        typeof data.submitted_at === 'string' ? data.submitted_at : new Date().toISOString(),
      commentCount: input.comments.length,
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

  private githubHeaders(token: string): Record<string, string> {
    return {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'Project-X',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  private async ensureRedis(): Promise<void> {
    if (this.redis.status === 'wait') {
      await this.redis.connect();
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
    result: CachedReviewResult,
  ): Promise<void> {
    try {
      await this.ensureRedis();
      const record: IdempotencyRecord = { kind: 'success', fingerprint, result };
      await this.redis.set(cacheKey, JSON.stringify(record), 'EX', IDEMPOTENCY_TTL_SECONDS);
    } catch {
      // Best-effort only.
    }
  }

  private async acquireLock(lockKey: string, fingerprint: string): Promise<boolean> {
    try {
      await this.ensureRedis();
      const result = await this.redis.set(lockKey, fingerprint, 'EX', LOCK_TTL_SECONDS, 'NX');
      return result === 'OK';
    } catch {
      // If Redis is down, proceed without lock (same best-effort posture as Day 12).
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
  ): Promise<CachedReviewResult | null> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const record = await this.readIdempotentRecord(cacheKey);
      if (record?.kind === 'success') {
        if (record.fingerprint !== fingerprint) {
          throw this.errors.toHttpException(
            'IDEMPOTENCY_CONFLICT',
            'This clientRequestId was already used with a different review payload.',
          );
        }
        return record.result;
      }
    }
    return null;
  }
}
