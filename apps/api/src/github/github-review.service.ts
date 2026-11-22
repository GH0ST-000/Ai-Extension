import { randomUUID } from 'node:crypto';

import { Injectable, Logger, Optional } from '@nestjs/common';
import type {
  GitHubWriteErrorCode,
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
import {
  GithubAccessService,
  repositoryAccessError,
  type GitHubApiTokenSource,
} from '../github-app/github-access.service';
import { GithubErrorNormalizer } from './github-error-normalizer';
import { reviewRequestFingerprint } from './review-fingerprint';
import { SecurityAuditService } from '../observability/security-audit.service';
import { attributeAppPost, isValidGithubLogin } from './github-attribution';
import { recordGithubWrite } from './github-write-audit';

const IDEMPOTENCY_TTL_SECONDS = 60 * 60 * 24; // 24h
const LOCK_TTL_SECONDS = 30;
/** GitHub POST deadline — below the lock TTL, so the lock never expires under a live write. */
const REVIEW_POST_TIMEOUT_MS = 20_000;
/** Upper bound for one Redis command of the idempotency protocol (a hang counts as down). */
const REDIS_COMMAND_TIMEOUT_MS = 1_500;
/** Delete the lock only if this request still owns it (never another request's lock). */
/** Extend the lock only if this request still owns it; 1 = extended. */
const EXTEND_OWN_LOCK = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return 0`;
/** How long an "outcome unknown" marker blocks a blind retry of the same request id. */
const UNKNOWN_OUTCOME_TTL_SECONDS = 10 * 60;
const RELEASE_OWN_LOCK = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`;

type GitHubPullResponse = {
  number?: number;
  state?: string;
  merged?: boolean;
  locked?: boolean;
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
  | { kind: 'lock'; fingerprint: string }
  /** The POST was sent and its outcome is not known (timeout / connection lost). */
  | { kind: 'unknown'; fingerprint: string };

@Injectable()
export class GithubReviewService {
  private readonly logger = new Logger(GithubReviewService.name);
  constructor(
    private readonly githubAccess: GithubAccessService,
    private readonly redis: RedisService,
    private readonly errors: GithubErrorNormalizer,
    @Optional() private readonly audit?: SecurityAuditService,
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
    this.assertOutcomeKnown(existing);
    if (existing?.kind === 'success') {
      if (existing.fingerprint !== fingerprint) {
        throw this.errors.toHttpException(
          'IDEMPOTENCY_CONFLICT',
          'This clientRequestId was already used with a different review payload.',
        );
      }
      return { ...existing.result, deduplicated: true };
    }

    const lockToken = await this.acquireLock(lockKey, fingerprint);
    if (!lockToken) {
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
      this.assertOutcomeKnown(afterLock);
      if (afterLock?.kind === 'success') {
        if (afterLock.fingerprint !== fingerprint) {
          throw this.errors.toHttpException(
            'IDEMPOTENCY_CONFLICT',
            'This clientRequestId was already used with a different review payload.',
          );
        }
        return { ...afterLock.result, deduplicated: true };
      }

      // H1: COMMENT reviews need the user's read access; REQUEST_CHANGES and APPROVE need
      // write. APPROVE through the shared workspace App bot is never allowed (below).
      const access = await this.githubAccess.resolveRepositoryAccess(userId, {
        owner,
        repository,
        access: event === 'COMMENT' ? 'comment' : 'write',
      });
      const deny = (
        code: GitHubWriteErrorCode,
        message: string,
        credential?: GitHubApiTokenSource,
      ) => {
        recordGithubWrite(this.audit, this.logger, {
          operation: 'review',
          outcome: 'blocked',
          userId,
          workspaceId: access.workspaceId,
          owner,
          repository,
          pullRequestNumber,
          ...(credential ? { credential } : {}),
          detail: `${event}:${code}`,
        });
        return this.errors.toHttpException(code, message);
      };
      if (!access.ok) {
        const denied = repositoryAccessError(access.reason);
        throw deny(denied.code, denied.message);
      }
      if (event === 'APPROVE' && access.source === 'installation') {
        throw deny(
          'REVIEW_ACTION_NOT_ALLOWED',
          'Approving through the shared Project X GitHub App is disabled. Approve on GitHub with your own account, or submit the review as a comment.',
          access.source,
        );
      }
      const token = access.token;

      const pull = await this.fetchPullRequest({ token, owner, repository, pullRequestNumber });
      if (pull.state !== 'open' || pull.merged) {
        throw this.errors.toHttpException(
          'PULL_REQUEST_NOT_FOUND',
          'This pull request is closed or merged. Refresh the PR page and start a new review draft.',
        );
      }

      // N-17: a locked conversation accepts reviews only from collaborators with write; the
      // App could still post, so the App path requires the user's own write access.
      if (pull.locked && access.source === 'installation' && event === 'COMMENT') {
        const writer = await this.githubAccess.resolveRepositoryAccess(userId, {
          owner,
          repository,
          access: 'write',
        });
        if (!writer.ok) {
          throw deny(
            'INSUFFICIENT_PERMISSION',
            'This pull request conversation is locked on GitHub. Only collaborators with write access can review.',
            access.source,
          );
        }
      }

      const headSha = pull.head?.sha;
      if (input.expectedHeadSha && headSha && input.expectedHeadSha !== headSha) {
        throw this.errors.toHttpException(
          'STALE_DIFF_POSITION',
          'The pull request head changed since this draft was created. Refresh the review before submitting inline comments.',
        );
      }

      const { inlineComments, aggregatedBody } = this.partitionComments(body, comments);
      // Decision C: App-posted reviews (COMMENT / REQUEST_CHANGES; APPROVE is refused above)
      // name the requesting user's verified GitHub login in the review body.
      let reviewBody = aggregatedBody;
      if (access.source === 'installation') {
        if (!isValidGithubLogin(access.actorGithubLogin)) {
          throw deny(
            'NOT_CONNECTED',
            'Project X could not confirm your GitHub username. Reconnect your GitHub token in dashboard Settings.',
            access.source,
          );
        }
        reviewBody = attributeAppPost(aggregatedBody, access.actorGithubLogin);
      }

      // The steps above (permission checks, token mint, PR lookup) are not all bounded: make
      // sure the lock is still OURS and give the POST its full window before writing. If it
      // expired meanwhile, another request may be writing — stop, nothing was posted.
      if (!(await this.extendLock(lockKey, lockToken))) {
        throw this.errors.toHttpException(
          'GITHUB_UNAVAILABLE',
          'The request took too long to prepare. Nothing was posted to GitHub. Please try again.',
        );
      }
      let result: CachedReviewResult;
      try {
        result = await this.createPullRequestReview({
          token,
          owner,
          repository,
          pullRequestNumber,
          event,
          body: reviewBody,
          commitId: headSha,
          // Decision C: each inline comment is attributed too (shown on its own in Files changed).
          comments:
            access.source === 'installation' && isValidGithubLogin(access.actorGithubLogin)
              ? inlineComments.map((comment) => ({
                  ...comment,
                  body: attributeAppPost(comment.body, access.actorGithubLogin as string),
                }))
              : inlineComments,
        });
      } catch (error) {
        if (isOutcomeUnknown(error)) {
          // GitHub may have created the review. A blind retry with the same request id would
          // post it twice, so this id is parked: retries get the same "check GitHub" answer
          // (never a second POST) until the marker expires or the user submits a new request.
          await this.storeUnknownOutcome(cacheKey, fingerprint);
        }
        throw error;
      }

      await this.storeIdempotentSuccess(cacheKey, fingerprint, {
        ...result,
        commentCount: comments.length,
      });
      recordGithubWrite(this.audit, this.logger, {
        operation: 'review',
        outcome: 'success',
        userId,
        workspaceId: access.workspaceId,
        owner,
        repository,
        pullRequestNumber,
        credential: access.source,
        detail: event,
        resultId: result.reviewId,
      });
      return { ...result, commentCount: comments.length, deduplicated: false };
    } finally {
      await this.releaseLock(lockKey, lockToken);
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
        // F-17: bounded below the lock TTL (a slow GitHub can no longer outlive the lock and
        // let a retry post a second review).
        signal: AbortSignal.timeout(REVIEW_POST_TIMEOUT_MS),
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

  /**
   * F-17 — the idempotency protocol FAILS CLOSED. A review has no natural compare-and-swap on
   * GitHub: the only thing that stops a retry (double click, lost response) from posting a
   * second review is this record and lock. If Redis cannot answer, we cannot know whether the
   * review was already posted, so nothing is written to GitHub and the caller is told to retry
   * (the same posture as PR comments). Every Redis command is bounded by a deadline.
   */
  private async redisCommand<T>(command: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await this.ensureRedis();
      return await Promise.race([
        command(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('redis timeout')), REDIS_COMMAND_TIMEOUT_MS);
        }),
      ]);
    } catch {
      throw this.errors.toHttpException(
        'GITHUB_UNAVAILABLE',
        'Unable to coordinate write safety. Nothing was posted to GitHub. Please try again shortly.',
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async readIdempotentRecord(cacheKey: string): Promise<IdempotencyRecord | null> {
    const raw = await this.redisCommand(() => this.redis.get(cacheKey));
    if (!raw) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as IdempotencyRecord;
      if (parsed.kind === 'success' && parsed.result?.success === true) {
        return parsed;
      }
      if (parsed.kind === 'unknown') {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * The review IS on GitHub at this point. Recording it is what makes a retry safe, so the
   * write is retried; if it still fails the response is returned (the client got its result
   * and has no reason to retry) and the gap is logged for follow-up.
   */
  private async storeIdempotentSuccess(
    cacheKey: string,
    fingerprint: string,
    result: CachedReviewResult,
  ): Promise<void> {
    const record: IdempotencyRecord = { kind: 'success', fingerprint, result };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.redisCommand(() =>
          this.redis.set(cacheKey, JSON.stringify(record), 'EX', IDEMPOTENCY_TTL_SECONDS),
        );
        return;
      } catch {
        // retried below
      }
    }
    this.logger.error({ msg: 'github.review.idempotency_record_not_stored' });
  }

  /** A parked request id (see storeUnknownOutcome): never POST again for it. */
  private assertOutcomeKnown(record: IdempotencyRecord | null): void {
    if (record?.kind === 'unknown') {
      throw this.errors.toHttpException(
        'WRITE_OUTCOME_UNKNOWN',
        'An earlier submission of this review may already be on GitHub. Check the pull request; to submit again, start a new review submission.',
      );
    }
  }

  private async storeUnknownOutcome(cacheKey: string, fingerprint: string): Promise<void> {
    const record: IdempotencyRecord = { kind: 'unknown', fingerprint };
    try {
      await this.redisCommand(() =>
        this.redis.set(cacheKey, JSON.stringify(record), 'EX', UNKNOWN_OUTCOME_TTL_SECONDS),
      );
    } catch {
      this.logger.error({ msg: 'github.review.unknown_outcome_marker_not_stored' });
    }
  }

  /** True when this request still owns the lock (its TTL is then reset to the full window). */
  private async extendLock(lockKey: string, token: string): Promise<boolean> {
    const extended = await this.redisCommand(() =>
      this.redis.eval(EXTEND_OWN_LOCK, 1, lockKey, token, LOCK_TTL_SECONDS),
    );
    return Number(extended) === 1;
  }

  /** Returns this request's lock token, or null when another request holds the lock. */
  private async acquireLock(lockKey: string, fingerprint: string): Promise<string | null> {
    const token = `${fingerprint}:${randomUUID()}`;
    const result = await this.redisCommand(() =>
      this.redis.set(lockKey, token, 'EX', LOCK_TTL_SECONDS, 'NX'),
    );
    return result === 'OK' ? token : null;
  }

  private async releaseLock(lockKey: string, token: string): Promise<void> {
    try {
      await this.redisCommand(() => this.redis.eval(RELEASE_OWN_LOCK, 1, lockKey, token));
    } catch {
      // The TTL expires the lock.
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

function isOutcomeUnknown(error: unknown): boolean {
  const response = (error as { getResponse?: () => unknown } | null)?.getResponse?.();
  return (
    typeof response === 'object' &&
    response !== null &&
    (response as { code?: unknown }).code === 'WRITE_OUTCOME_UNKNOWN'
  );
}
