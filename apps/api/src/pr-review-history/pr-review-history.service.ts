import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  PRReviewDiffSource,
  PrReviewHistoryItem,
  PrReviewHistoryPage,
  PrReviewHistoryPersistence,
  PrReviewReportDetail,
  PrReviewReportSnapshot,
  PrReviewReportStatus,
} from '@project-x/types';
import {
  PR_REVIEW_HISTORY_DEFAULT_LIMIT,
  PR_REVIEW_HISTORY_MAX_LIMIT,
  PR_REVIEW_REPORT_SCHEMA_VERSION,
} from '@project-x/types';

import { GithubAccessService } from '../github-app/github-access.service';
import { MetricsService } from '../observability/metrics.service';
import { RequestContextService } from '../observability/request-context.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import {
  buildPrReviewSnapshot,
  capMarkdown,
  memoryForViewer,
  type PrReviewSnapshotInput,
} from './pr-review-history.snapshot';

/** What the PR review engine hands over when a run settles. */
export interface RecordPrReviewInput extends PrReviewSnapshotInput {
  workspaceId: string;
  userId: string;
  operationId: string;
  owner: string;
  repository: string;
  pullRequestNumber: number;
  pullRequestTitle?: string;
  headSha?: string | null;
  baseBranch?: string;
  headBranch?: string;
  markdown: string | null;
  startedAt: Date;
  completedAt: Date;
}

export type RepositoryAccess = 'allowed' | 'denied' | 'unavailable';

/**
 * Listing scan budget (per request). The list walks reports in cursor order and authorizes
 * each report's repository; these bound the work so one request never scans the whole table
 * or fans out to GitHub. When a budget is reached the page is returned short with a cursor at
 * the last *authorized* report, so the next request continues exactly there.
 */
export const HISTORY_SCAN_MAX_ROWS = 1_000;
/** Uncached GitHub repository lookups per listing request (cache hits are free). */
export const HISTORY_SCAN_MAX_GITHUB_CHECKS = 20;
const HISTORY_SCAN_BATCH = 100;
/**
 * Repository access cache (Redis). Keys are bound to workspace + viewer + repository + the
 * identity of the GitHub credential that produced the answer (installation id, or the
 * personal token's connection version — never anything derived from a token), so removing / suspending / relinking the App or
 * disconnecting / replacing a token invalidates every cached answer immediately.
 * The TTL only bounds revocations made on GitHub itself (repository removed from the
 * installation, collaborator removed) while the credential stays the same — and it only
 * applies to list metadata: opening report content always re-checks GitHub live.
 */
const ACCESS_ALLOWED_TTL_S = 60;
const ACCESS_DENIED_TTL_S = 60;
const GITHUB_TIMEOUT_MS = 5_000;
const ACCESS_CHECK_CONCURRENCY = 5;

const LIST_SELECT = {
  id: true,
  schemaVersion: true,
  userId: true,
  owner: true,
  repository: true,
  pullRequestNumber: true,
  pullRequestTitle: true,
  headSha: true,
  status: true,
  failureCode: true,
  riskLevel: true,
  diffSource: true,
  findingsCount: true,
  needsInvestigationCount: true,
  filesTotal: true,
  filesReviewed: true,
  coverageComplete: true,
  memoryMode: true,
  memoryStatus: true,
  startedAt: true,
  completedAt: true,
  createdAt: true,
  user: { select: { name: true } },
} satisfies Prisma.PrReviewReportSelect;

type ListRow = Prisma.PrReviewReportGetPayload<{ select: typeof LIST_SELECT }>;

/**
 * Persistent PR review history.
 *
 * Write side: one immutable row per review execution (unique per workspace + operation id),
 * written after the run settled — never inside a transaction that spans an AI call, and
 * best-effort: a history failure never changes the review response or its usage charge.
 *
 * Read side: workspace membership (WorkspaceGuard, `workspace:read`) AND current GitHub
 * access to the report's repository, resolved through the workspace's GitHub App
 * installation or the viewer's own token. Report ids are scoped to the workspace, so knowing
 * an id never grants access by itself. Reading never calls the AI, never charges usage and
 * only performs a read-only GitHub repository lookup.
 */
@Injectable()
export class PrReviewHistoryService {
  private readonly logger = new Logger(PrReviewHistoryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly githubAccess: GithubAccessService,
    private readonly redis: RedisService,
    private readonly requestContext: RequestContextService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  // ---------------------------------------------------------------- write side

  /**
   * Store the snapshot of a settled run and report what PostgreSQL confirmed:
   * - `saved` only when the database returned the row (new, or the existing row of the same
   *   operation — persistence is idempotent and the first snapshot wins);
   * - `not_saved` when the insert failed;
   * - `unknown` when a duplicate could not be re-read to confirm it.
   * Never throws: a history failure must not change the review response or its usage charge.
   * Logs and metrics carry codes and ids only — never SQL, payloads or driver messages.
   */
  async record(input: RecordPrReviewInput): Promise<PrReviewHistoryPersistence> {
    const startedAt = process.hrtime.bigint();
    const finish = (
      outcome: 'created' | 'duplicate' | 'failed' | 'unconfirmed',
      result: PrReviewHistoryPersistence,
      error?: unknown,
    ): PrReviewHistoryPersistence => {
      const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      this.metrics?.recordPrReviewHistoryWrite(outcome, input.status, seconds);
      const fields = {
        operationId: input.operationId,
        workspaceId: input.workspaceId,
        reviewStatus: input.status,
        outcome,
        durationMs: Math.round(seconds * 1000),
        ...(result.status === 'saved' ? { reportId: result.reportId } : {}),
        ...(error ? describeError(error) : {}),
      };
      if (outcome === 'failed' || outcome === 'unconfirmed') {
        this.logger.error({ msg: 'pr_review_history.persist_failed', ...fields });
      } else {
        this.logger.log({ msg: 'pr_review_history.persisted', ...fields });
      }
      return result;
    };

    let data: Prisma.PrReviewReportUncheckedCreateInput;
    try {
      data = this.toRow(input);
    } catch (error) {
      return finish('failed', { status: 'not_saved' }, error);
    }
    try {
      const row = await this.prisma.prReviewReport.create({ data, select: { id: true } });
      return finish('created', { status: 'saved', reportId: row.id });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) {
        return finish('failed', { status: 'not_saved' }, error);
      }
    }
    // Same operation already stored (retry / concurrent call): confirm it really exists.
    try {
      const existing = await this.prisma.prReviewReport.findUnique({
        where: {
          workspaceId_operationId: {
            workspaceId: input.workspaceId,
            operationId: input.operationId,
          },
        },
        select: { id: true },
      });
      return existing
        ? finish('duplicate', { status: 'saved', reportId: existing.id })
        : finish('unconfirmed', { status: 'unknown' });
    } catch (error) {
      return finish('unconfirmed', { status: 'unknown' }, error);
    }
  }

  private toRow(input: RecordPrReviewInput): Prisma.PrReviewReportUncheckedCreateInput {
    const snapshot = buildPrReviewSnapshot(input);
    const coverage = input.coverage;
    const reviewed = coverage
      ? coverage.counts.reviewed_full + coverage.counts.reviewed_partial
      : 0;
    return {
      schemaVersion: PR_REVIEW_REPORT_SCHEMA_VERSION,
      workspaceId: input.workspaceId,
      userId: input.userId,
      operationId: input.operationId,
      owner: input.owner.toLowerCase(),
      repository: input.repository.toLowerCase(),
      pullRequestNumber: input.pullRequestNumber,
      pullRequestTitle: input.pullRequestTitle?.slice(0, 300) ?? null,
      headSha: input.headSha ?? null,
      baseBranch: input.baseBranch?.slice(0, 255) ?? null,
      headBranch: input.headBranch?.slice(0, 255) ?? null,
      status: input.status,
      failureCode: input.failureCode ?? null,
      riskLevel: input.status === 'failed' ? null : (coverage?.riskLevel ?? null),
      diffSource: coverage?.source ?? input.reviewScope?.source ?? null,
      findingsCount: snapshot.findings.filter((f) => f.disposition === 'reported').length,
      needsInvestigationCount: snapshot.findings.filter(
        (f) => f.disposition === 'needs_investigation',
      ).length,
      filesTotal: coverage?.totalFiles ?? input.reviewScope?.totalFiles ?? null,
      filesReviewed: reviewed,
      coverageComplete: coverage?.complete === true && input.status === 'completed',
      memoryMode: snapshot.memory?.mode ?? null,
      memoryStatus: snapshot.memory?.status ?? null,
      snapshot: snapshot as unknown as Prisma.InputJsonValue,
      reportMarkdown: input.status === 'failed' ? null : capMarkdown(input.markdown),
      startedAt: input.startedAt,
      completedAt: input.completedAt,
    };
  }

  /**
   * Whether the caller's own review operation has a stored snapshot (database-confirmed).
   * Initiator only: operation ids are per-user; other members find reports through the list.
   */
  async operationStatus(
    userId: string,
    workspaceId: string,
    operationId: string,
  ): Promise<PrReviewHistoryPersistence> {
    this.assertWorkspaceContext(workspaceId);
    const row = await this.prisma.prReviewReport.findUnique({
      where: { workspaceId_operationId: { workspaceId, operationId } },
      select: { id: true, userId: true },
    });
    if (!row || row.userId !== userId) return { status: 'not_saved' };
    return { status: 'saved', reportId: row.id };
  }

  // ----------------------------------------------------------------- read side

  async list(
    userId: string,
    workspaceId: string,
    query: {
      owner?: string;
      repository?: string;
      pullRequestNumber?: number;
      status?: PrReviewReportStatus;
      cursor?: string;
      limit?: number;
    },
  ): Promise<PrReviewHistoryPage> {
    this.assertWorkspaceContext(workspaceId);
    const limit = clampLimit(query.limit);
    const owner = query.owner?.toLowerCase();
    const repository = query.repository?.toLowerCase();
    if (query.pullRequestNumber !== undefined && (!owner || !repository)) {
      throw new BadRequestException('pullRequestNumber requires owner and repository.');
    }
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;

    const base: Prisma.PrReviewReportWhereInput = {
      workspaceId,
      ...(owner ? { owner } : {}),
      ...(repository ? { repository } : {}),
      ...(query.pullRequestNumber !== undefined
        ? { pullRequestNumber: query.pullRequestNumber }
        : {}),
      ...(query.status ? { status: query.status } : {}),
    };

    // Walk reports in (createdAt desc, id desc) order and authorize each report's repository.
    // Every report is either returned, skipped as inaccessible, or left for the next page —
    // the cursor only ever advances past reports that were actually decided.
    const access = new Map<string, RepositoryAccess>();
    let identity: string | null;
    try {
      identity = await this.githubAccess.resolveCredentialIdentity(userId, workspaceId);
    } catch {
      throw new ServiceUnavailableException(
        'Unable to verify repository access with GitHub right now. Try again shortly.',
      );
    }
    const budget = { githubChecks: HISTORY_SCAN_MAX_GITHUB_CHECKS };
    const items: ListRow[] = [];
    let position = cursor;
    let lastDecided: ListRow | null = null;
    let scanned = 0;
    let someRepositoriesHidden = false;
    let accessCheckIncomplete = false;
    let stopped = false;
    let reachedEnd = false;

    while (items.length < limit && scanned < HISTORY_SCAN_MAX_ROWS && !stopped) {
      const take = Math.min(HISTORY_SCAN_BATCH, HISTORY_SCAN_MAX_ROWS - scanned);
      const rows = await this.prisma.prReviewReport.findMany({
        where: { AND: [base, afterCursor(position)] },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take,
        select: LIST_SELECT,
      });
      await this.resolveAccess(userId, workspaceId, identity, rows, access, budget);
      for (const row of rows) {
        const decision = access.get(repoKey(row));
        if (decision === undefined || decision === 'unavailable') {
          // Not decidable now (GitHub budget spent, or GitHub unavailable): stop before it.
          if (decision === 'unavailable') accessCheckIncomplete = true;
          stopped = true;
          break;
        }
        lastDecided = row;
        scanned += 1;
        if (decision === 'allowed') items.push(row);
        else someRepositoriesHidden = true;
        if (items.length === limit) break;
      }
      if (lastDecided) position = { createdAt: lastDecided.createdAt, id: lastDecided.id };
      if (!stopped && items.length < limit && rows.length < take) {
        reachedEnd = true;
        break;
      }
    }

    if (items.length === 0 && accessCheckIncomplete && !lastDecided) {
      throw new ServiceUnavailableException(
        'Unable to verify repository access with GitHub right now. Try again shortly.',
      );
    }

    let nextCursor: string | null = null;
    if (!reachedEnd && position) {
      // A full page may end exactly at the last report: only hand out a cursor if more exist.
      const more =
        stopped ||
        (await this.prisma.prReviewReport.findFirst({
          where: { AND: [base, afterCursor(position)] },
          select: { id: true },
        })) !== null;
      if (more) nextCursor = encodeCursor(position.createdAt, position.id);
    }
    return {
      items: items.map((row) => toItem(row, userId)),
      nextCursor,
      someRepositoriesHidden,
      accessCheckIncomplete,
    };
  }

  async get(userId: string, workspaceId: string, reportId: string): Promise<PrReviewReportDetail> {
    this.assertWorkspaceContext(workspaceId);
    // Scoped by workspace: an id from another workspace is indistinguishable from a missing one.
    const row = await this.prisma.prReviewReport.findFirst({
      where: { id: reportId, workspaceId },
      select: {
        ...LIST_SELECT,
        baseBranch: true,
        headBranch: true,
        snapshot: true,
        reportMarkdown: true,
      },
    });
    if (!row) throw notFound();
    await this.assertRepositoryAccess(userId, workspaceId, row.owner, row.repository);
    return toDetail(row, userId);
  }

  async latest(
    userId: string,
    workspaceId: string,
    ownerRaw: string,
    repositoryRaw: string,
    pullRequestNumber: number,
  ): Promise<PrReviewReportDetail | null> {
    this.assertWorkspaceContext(workspaceId);
    const owner = ownerRaw.toLowerCase();
    const repository = repositoryRaw.toLowerCase();
    // Access first: the answer must not reveal whether an inaccessible repository has history.
    await this.assertRepositoryAccess(userId, workspaceId, owner, repository);
    const row = await this.prisma.prReviewReport.findFirst({
      where: { workspaceId, owner, repository, pullRequestNumber },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        ...LIST_SELECT,
        baseBranch: true,
        headBranch: true,
        snapshot: true,
        reportMarkdown: true,
      },
    });
    return row ? toDetail(row, userId) : null;
  }

  // ------------------------------------------------------- repository access

  /**
   * Gate for report *content* (detail, latest): a cached "denied" may short-circuit, but
   * "allowed" is always re-confirmed with GitHub, so a revoked permission never exposes
   * findings or evidence from a private repository.
   */
  private async assertRepositoryAccess(
    userId: string,
    workspaceId: string,
    owner: string,
    repository: string,
  ): Promise<void> {
    let access: RepositoryAccess;
    try {
      const identity = await this.githubAccess.resolveCredentialIdentity(userId, workspaceId);
      access =
        identity === null
          ? 'denied'
          : (await this.cachedAccess(workspaceId, userId, identity, owner, repository)) === 'denied'
            ? 'denied'
            : await this.githubAccessCheck(userId, workspaceId, owner, repository);
    } catch {
      access = 'unavailable';
    }
    if (access === 'unavailable') {
      throw new ServiceUnavailableException(
        'Unable to verify repository access with GitHub right now. Try again shortly.',
      );
    }
    if (access === 'denied') throw notFound();
  }

  /**
   * Decide access for the repositories of `rows` that are not decided yet: cached answers
   * first (free), then live GitHub lookups in order of first appearance while the request's
   * budget lasts. Undecided repositories stay absent from `access`.
   */
  private async resolveAccess(
    userId: string,
    workspaceId: string,
    identity: string | null,
    rows: ReadonlyArray<{ owner: string; repository: string }>,
    access: Map<string, RepositoryAccess>,
    budget: { githubChecks: number },
  ): Promise<void> {
    const pending: Array<{ owner: string; repository: string }> = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const key = repoKey(row);
      if (access.has(key) || seen.has(key)) continue;
      seen.add(key);
      if (identity === null) {
        // No usable GitHub credential: nothing is accessible (no cache, no GitHub call).
        access.set(key, 'denied');
        continue;
      }
      const cached = await this.cachedAccess(
        workspaceId,
        userId,
        identity,
        row.owner,
        row.repository,
      );
      if (cached) access.set(key, cached);
      else pending.push(row);
    }
    const batch = pending.slice(0, Math.max(0, budget.githubChecks));
    budget.githubChecks -= batch.length;
    let next = 0;
    const worker = async () => {
      while (next < batch.length) {
        const repo = batch[next++]!;
        access.set(
          repoKey(repo),
          await this.githubAccessCheck(userId, workspaceId, repo.owner, repo.repository),
        );
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(ACCESS_CHECK_CONCURRENCY, batch.length) }, worker),
    );
  }

  /**
   * Read-only GitHub lookup of the repository with the workspace's installation token (or the
   * viewer's own token when the workspace has no installation). Fails closed. Cached briefly
   * per workspace + viewer + repository + credential identity; transient failures are never
   * cached.
   */
  async checkRepositoryAccess(
    userId: string,
    workspaceId: string,
    owner: string,
    repository: string,
  ): Promise<RepositoryAccess> {
    const identity = await this.githubAccess.resolveCredentialIdentity(userId, workspaceId);
    if (identity === null) return 'denied';
    return (
      (await this.cachedAccess(workspaceId, userId, identity, owner, repository)) ??
      (await this.githubAccessCheck(userId, workspaceId, owner, repository))
    );
  }

  private async cachedAccess(
    workspaceId: string,
    userId: string,
    identity: string,
    owner: string,
    repository: string,
  ): Promise<'allowed' | 'denied' | null> {
    const cached = await this.cacheGet(
      accessCacheKey(workspaceId, userId, identity, owner, repository),
    );
    if (cached === 'allowed' || cached === 'denied') {
      this.metrics?.recordPrReviewHistoryAccessCheck('cache', cached);
      return cached;
    }
    return null;
  }

  private async githubAccessCheck(
    userId: string,
    workspaceId: string,
    owner: string,
    repository: string,
  ): Promise<RepositoryAccess> {
    const result = await this.githubLookup(userId, workspaceId, owner, repository);
    this.metrics?.recordPrReviewHistoryAccessCheck('github', result);
    return result;
  }

  private async githubLookup(
    userId: string,
    workspaceId: string,
    owner: string,
    repository: string,
  ): Promise<RepositoryAccess> {
    // The identity (non-secret) and the token are resolved separately so no secret ever flows
    // into the cache key. The answer is cached only if the credential identity is the same
    // before and after the lookup, i.e. it was produced by the credential the key names.
    let identity: string | null;
    let token: string | null;
    try {
      identity = await this.githubAccess.resolveCredentialIdentity(userId, workspaceId);
      token = identity
        ? ((await this.githubAccess.resolveApiToken(userId, workspaceId))?.token ?? null)
        : null;
    } catch {
      return 'unavailable';
    }
    // No credential: denied, and nothing to cache (there is no identity to bind it to).
    if (!identity || !token) return 'denied';
    let response: Response;
    try {
      response = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`,
        {
          method: 'GET',
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'User-Agent': 'Project-X',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
        },
      );
    } catch {
      return 'unavailable';
    }
    const result: RepositoryAccess = response.ok
      ? 'allowed'
      : response.status === 401 || response.status === 403 || response.status === 404
        ? 'denied'
        : 'unavailable';
    if (result !== 'unavailable') {
      await this.cacheIfCredentialUnchanged(
        userId,
        workspaceId,
        identity,
        owner,
        repository,
        result,
      );
    }
    return result;
  }

  private async cacheIfCredentialUnchanged(
    userId: string,
    workspaceId: string,
    identity: string,
    owner: string,
    repository: string,
    result: 'allowed' | 'denied',
  ): Promise<void> {
    let after: string | null;
    try {
      after = await this.githubAccess.resolveCredentialIdentity(userId, workspaceId);
    } catch {
      return;
    }
    // The credential changed while GitHub was being asked: the answer belongs to neither key.
    if (after !== identity) return;
    await this.cacheSet(
      accessCacheKey(workspaceId, userId, identity, owner, repository),
      result,
      result === 'allowed' ? ACCESS_ALLOWED_TTL_S : ACCESS_DENIED_TTL_S,
    );
  }

  private async cacheGet(key: string): Promise<string | null> {
    try {
      return await this.redis.get(key);
    } catch {
      return null;
    }
  }

  private async cacheSet(key: string, value: RepositoryAccess, ttlSeconds: number): Promise<void> {
    try {
      await this.redis.set(key, value, 'EX', ttlSeconds);
    } catch {
      // Cache is an optimization only.
    }
  }

  /**
   * GitHub credentials are resolved for the workspace in the request context (the
   * X-Workspace-Id header) when present; it must be the workspace in the URL.
   */
  private assertWorkspaceContext(workspaceId: string): void {
    const fromHeader = this.requestContext.get()?.workspaceId;
    if (fromHeader && fromHeader !== workspaceId) {
      throw new BadRequestException('X-Workspace-Id does not match the workspace in the URL.');
    }
  }
}

function repoKey(row: { owner: string; repository: string }): string {
  return `${row.owner}/${row.repository}`;
}

/**
 * Every component is non-secret (ids, installation id / connection version, repository) — no
 * hashing needed. Components are URI-encoded so none can contain the separator and collide.
 */
function accessCacheKey(
  workspaceId: string,
  userId: string,
  identity: string,
  owner: string,
  repository: string,
): string {
  return [
    'px:prh:access:v3',
    workspaceId,
    userId,
    identity,
    owner.toLowerCase(),
    repository.toLowerCase(),
  ]
    .map((part, i) => (i === 0 ? part : encodeURIComponent(part)))
    .join(':');
}

function afterCursor(
  position: { createdAt: Date; id: string } | null,
): Prisma.PrReviewReportWhereInput {
  if (!position) return {};
  return {
    OR: [
      { createdAt: { lt: position.createdAt } },
      { createdAt: position.createdAt, id: { lt: position.id } },
    ],
  };
}

/** Error class and Prisma code only — never messages (they can contain SQL or values). */
function describeError(error: unknown): { errorName: string; errorCode?: string } {
  const errorName = error instanceof Error ? error.name : 'unknown';
  const code =
    error instanceof Prisma.PrismaClientKnownRequestError
      ? error.code
      : error instanceof Prisma.PrismaClientInitializationError
        ? (error.errorCode ?? 'init')
        : undefined;
  return { errorName, ...(code ? { errorCode: code } : {}) };
}

function notFound(): NotFoundException {
  return new NotFoundException('Review report not found.');
}

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return PR_REVIEW_HISTORY_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), PR_REVIEW_HISTORY_MAX_LIMIT);
}

export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const [iso, id] = decoded.split('|');
  const createdAt = iso ? new Date(iso) : new Date(NaN);
  if (!id || !/^[a-z0-9]{1,64}$/i.test(id) || Number.isNaN(createdAt.getTime())) {
    throw new BadRequestException('Invalid cursor.');
  }
  return { createdAt, id };
}

function toItem(row: ListRow, viewerId: string): PrReviewHistoryItem {
  return {
    id: row.id,
    schemaVersion: row.schemaVersion,
    owner: row.owner,
    repository: row.repository,
    pullRequestNumber: row.pullRequestNumber,
    pullRequestTitle: row.pullRequestTitle,
    headSha: row.headSha,
    status: row.status as PrReviewReportStatus,
    failureCode: row.failureCode,
    riskLevel: row.riskLevel,
    diffSource: row.diffSource as PRReviewDiffSource | null,
    findingsCount: row.findingsCount,
    needsInvestigationCount: row.needsInvestigationCount,
    filesTotal: row.filesTotal,
    filesReviewed: row.filesReviewed,
    coverageComplete: row.coverageComplete,
    memoryMode: row.memoryMode === 'on' || row.memoryMode === 'off' ? row.memoryMode : null,
    memoryStatus: row.memoryStatus,
    initiatedByMe: row.userId === viewerId,
    initiatorName: row.user?.name ?? null,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

function toDetail(
  row: ListRow & {
    baseBranch: string | null;
    headBranch: string | null;
    snapshot: Prisma.JsonValue;
    reportMarkdown: string | null;
  },
  viewerId: string,
): PrReviewReportDetail {
  const stored = row.snapshot as unknown as PrReviewReportSnapshot;
  const initiator = row.userId === viewerId;
  return {
    ...toItem(row, viewerId),
    baseBranch: row.baseBranch,
    headBranch: row.headBranch,
    snapshot: { ...stored, memory: memoryForViewer(stored.memory ?? null, initiator) },
    reportMarkdown: row.reportMarkdown,
  };
}
