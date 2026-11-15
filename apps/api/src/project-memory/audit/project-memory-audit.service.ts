import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  ProjectMemoryAuditActorType,
  ProjectMemoryAuditEvent,
  ProjectMemoryAuditEventType,
  ProjectMemoryAuditPage,
  ProjectMemoryAuditQuery,
  ProjectMemoryAuditReason,
  ProjectMemoryAuditRulePage,
  ProjectMemoryAuditRuleQuery,
  ProjectMemoryAuditState,
} from '@project-x/types';
import {
  PROJECT_MEMORY_AUDIT_DEFAULT_LIMIT,
  PROJECT_MEMORY_AUDIT_MAX_LIMIT,
  PROJECT_MEMORY_AUDIT_RULES_DEFAULT_LIMIT,
  PROJECT_MEMORY_AUDIT_RULES_MAX_LIMIT,
} from '@project-x/types';

import { FeatureGate } from '../../entitlements/feature-gate';
import { RequestContextService } from '../../observability/request-context.service';
import { PrismaService } from '../../prisma/prisma.service';

/** Longest date range a single query may span. */
const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1000;

type AuditRow = Prisma.ProjectMemoryAuditEventGetPayload<Record<string, never>>;

/**
 * Read side of the Project Memory audit log.
 *
 * Authorization: WorkspaceGuard (`memory:read`, membership checked live) + the PROJECT_MEMORY
 * plan feature — the same boundary as reading memory itself. The privacy rule is part of the
 * SQL WHERE clause, applied before ordering, pagination and filters: shared-rule events are
 * visible to the workspace, personal-preference events only to the preference owner (Owners
 * and Admins included). An event the viewer may not see is indistinguishable from one that
 * does not exist.
 */
@Injectable()
export class ProjectMemoryAuditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly featureGate: FeatureGate,
    private readonly requestContext: RequestContextService,
  ) {}

  async list(
    viewerId: string,
    workspaceId: string,
    query: ProjectMemoryAuditQuery,
  ): Promise<ProjectMemoryAuditPage> {
    await this.assertAccess(workspaceId);
    const limit = clampLimit(query.limit);
    const { from, to } = dateRange(query.from, query.to);
    const cursor = query.cursor ? decodeAuditCursor(query.cursor) : null;

    const rows = await this.prisma.projectMemoryAuditEvent.findMany({
      where: {
        AND: [
          visibleTo(viewerId, workspaceId),
          query.owner ? { owner: query.owner.toLowerCase() } : {},
          query.repository ? { repository: query.repository.toLowerCase() } : {},
          query.memoryId ? { memoryId: query.memoryId } : {},
          query.eventType ? { eventType: query.eventType } : {},
          query.actorType ? { actorType: query.actorType } : {},
          query.actorUserId ? { actorUserId: query.actorUserId } : {},
          from || to
            ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } }
            : {},
          cursor
            ? {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                ],
              }
            : {},
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((row) => toEvent(row, viewerId)),
      nextCursor: rows.length > limit && last ? encodeAuditCursor(last.createdAt, last.id) : null,
    };
  }

  /**
   * Grouped view: one row per memory rule (grouped by the rule's id, never its key), ordered
   * by the rule's most recent matching event. The visibility rule and every filter are part of
   * the WHERE clause, so grouping, counts and pagination only ever see permitted events.
   * Constant work per page: four queries regardless of how many rules or events it shows.
   */
  async listRules(
    viewerId: string,
    workspaceId: string,
    query: ProjectMemoryAuditRuleQuery,
  ): Promise<ProjectMemoryAuditRulePage> {
    await this.assertAccess(workspaceId);
    const limit = Math.min(
      Math.max(Math.trunc(query.limit ?? PROJECT_MEMORY_AUDIT_RULES_DEFAULT_LIMIT), 1),
      PROJECT_MEMORY_AUDIT_RULES_MAX_LIMIT,
    );
    const { from, to } = dateRange(query.from, query.to);
    const cursor = query.cursor ? decodeAuditCursor(query.cursor) : null;

    const visible = visibleSql(viewerId, workspaceId);
    const conditions: Prisma.Sql[] = [visible];
    if (query.owner) conditions.push(Prisma.sql`owner = ${query.owner.toLowerCase()}`);
    if (query.repository) {
      conditions.push(Prisma.sql`repository = ${query.repository.toLowerCase()}`);
    }
    if (query.eventType) conditions.push(Prisma.sql`event_type = ${query.eventType}`);
    if (query.actorType) conditions.push(Prisma.sql`actor_type = ${query.actorType}`);
    if (query.actorUserId) conditions.push(Prisma.sql`actor_user_id = ${query.actorUserId}`);
    if (from) conditions.push(Prisma.sql`created_at >= ${utcTimestamp(from)}`);
    if (to) conditions.push(Prisma.sql`created_at < ${utcTimestamp(to)}`);
    const search = query.q?.trim();
    if (search) {
      conditions.push(Prisma.sql`key ILIKE ${`%${escapeLike(search)}%`} ESCAPE '\\'`);
    }
    const matching = Prisma.join(conditions, ' AND ');

    const groups = await this.prisma.$queryRaw<
      Array<{ memory_id: string; last_at: Date; matching: number }>
    >`
      SELECT memory_id, max(created_at) AS last_at, count(*)::int AS matching
      FROM project_memory_audit_events
      WHERE ${matching}
      GROUP BY memory_id
      ${
        cursor
          ? Prisma.sql`HAVING max(created_at) < ${utcTimestamp(cursor.createdAt)}
              OR (max(created_at) = ${utcTimestamp(cursor.createdAt)} AND memory_id < ${cursor.id})`
          : Prisma.empty
      }
      ORDER BY last_at DESC, memory_id DESC
      LIMIT ${limit + 1}`;
    const page = groups.slice(0, limit);
    if (page.length === 0) return { items: [], nextCursor: null };
    const ids = page.map((group) => group.memory_id);

    // Latest matching event of each rule on the page, and each rule's totals / latest state
    // over everything the viewer may see (filters ignored).
    const [latestIds, totals] = await Promise.all([
      this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT DISTINCT ON (memory_id) id
        FROM project_memory_audit_events
        WHERE ${matching} AND memory_id = ANY(${ids}::text[])
        ORDER BY memory_id, created_at DESC, id DESC`,
      this.prisma.$queryRaw<
        Array<{ memory_id: string; total: number; new_state: Prisma.JsonValue }>
      >`
        SELECT DISTINCT ON (memory_id) memory_id, new_state,
               count(*) OVER (PARTITION BY memory_id)::int AS total
        FROM project_memory_audit_events
        WHERE ${visible} AND memory_id = ANY(${ids}::text[])
        ORDER BY memory_id, created_at DESC, id DESC`,
    ]);
    const latestRows = await this.prisma.projectMemoryAuditEvent.findMany({
      where: {
        AND: [visibleTo(viewerId, workspaceId), { id: { in: latestIds.map((row) => row.id) } }],
      },
    });
    const latestByRule = new Map(latestRows.map((row) => [row.memoryId, row]));
    const totalByRule = new Map(totals.map((row) => [row.memory_id, row]));

    const items = page.flatMap((group) => {
      const latest = latestByRule.get(group.memory_id);
      if (!latest) return [];
      const event = toEvent(latest, viewerId);
      const total = totalByRule.get(group.memory_id);
      const state = total ? safeState(total.new_state, event.visibility === 'user') : null;
      return [
        {
          memoryId: group.memory_id,
          owner: event.owner,
          repository: event.repository,
          category: event.category,
          key: event.key,
          visibility: event.visibility,
          matchingEventCount: group.matching,
          totalEventCount: total?.total ?? group.matching,
          latestEvent: event,
          currentStatus: state?.status ?? null,
        },
      ];
    });
    const last = page[page.length - 1]!;
    return {
      items,
      nextCursor: groups.length > limit ? encodeAuditCursor(last.last_at, last.memory_id) : null,
    };
  }

  async get(
    viewerId: string,
    workspaceId: string,
    eventId: string,
  ): Promise<ProjectMemoryAuditEvent> {
    await this.assertAccess(workspaceId);
    const row = await this.prisma.projectMemoryAuditEvent.findFirst({
      where: { AND: [{ id: eventId }, visibleTo(viewerId, workspaceId)] },
    });
    if (!row) throw new NotFoundException('Audit event not found.');
    return toEvent(row, viewerId);
  }

  private async assertAccess(workspaceId: string): Promise<void> {
    const fromHeader = this.requestContext.get()?.workspaceId;
    if (fromHeader && fromHeader !== workspaceId) {
      throw new BadRequestException('X-Workspace-Id does not match the workspace in the URL.');
    }
    await this.featureGate.require(workspaceId, 'PROJECT_MEMORY');
  }
}

/** Same privacy rule as {@link visibleTo}, for raw SQL. */
function visibleSql(viewerId: string, workspaceId: string): Prisma.Sql {
  return Prisma.sql`workspace_id = ${workspaceId}
    AND (visibility = 'workspace' OR (visibility = 'user' AND subject_user_id = ${viewerId}))`;
}

/** `created_at` is a UTC timestamp without time zone: compare against UTC explicitly. */
function utcTimestamp(date: Date): Prisma.Sql {
  return Prisma.sql`(${date.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
}

/** Escape LIKE wildcards so a search is always a literal substring match. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function dateRange(fromRaw?: string, toRaw?: string): { from: Date | null; to: Date | null } {
  const from = fromRaw ? new Date(fromRaw) : null;
  const to = toRaw ? new Date(toRaw) : null;
  if (from && to) {
    if (from.getTime() >= to.getTime()) {
      throw new BadRequestException('"from" must be before "to".');
    }
    if (to.getTime() - from.getTime() > MAX_RANGE_MS) {
      throw new BadRequestException('The date range may span at most one year.');
    }
  }
  return { from, to };
}

/** The privacy rule, as a WHERE clause (applied before anything else). */
export function visibleTo(
  viewerId: string,
  workspaceId: string,
): Prisma.ProjectMemoryAuditEventWhereInput {
  return {
    workspaceId,
    OR: [{ visibility: 'workspace' }, { visibility: 'user', subjectUserId: viewerId }],
  };
}

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return PROJECT_MEMORY_AUDIT_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), PROJECT_MEMORY_AUDIT_MAX_LIMIT);
}

export function encodeAuditCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

export function decodeAuditCursor(cursor: string): { createdAt: Date; id: string } {
  const [iso, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const createdAt = iso ? new Date(iso) : new Date(NaN);
  if (!id || !/^[a-z0-9]{1,64}$/i.test(id) || Number.isNaN(createdAt.getTime())) {
    throw new BadRequestException('Invalid cursor.');
  }
  return { createdAt, id };
}

/** Defense in depth: a personal-preference state never carries text or scope. */
function safeState(
  value: Prisma.JsonValue | null,
  personal: boolean,
): ProjectMemoryAuditState | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const state = value as ProjectMemoryAuditState;
  if (!personal) return state;
  return {
    ...(state.status ? { status: state.status } : {}),
    ...(state.confidence ? { confidence: state.confidence } : {}),
  };
}

function toEvent(row: AuditRow, viewerId: string): ProjectMemoryAuditEvent {
  const personal = row.visibility === 'user';
  return {
    id: row.id,
    schemaVersion: row.schemaVersion,
    eventType: row.eventType as ProjectMemoryAuditEventType,
    actorType: row.actorType as ProjectMemoryAuditActorType,
    actorUserId: row.actorUserId,
    actorName: row.actorName,
    actorIsViewer: row.actorUserId !== null && row.actorUserId === viewerId,
    reason: (row.reason as ProjectMemoryAuditReason | null) ?? null,
    memoryId: row.memoryId,
    relatedMemoryId: row.relatedMemoryId,
    visibility: personal ? 'user' : 'workspace',
    provider: row.provider,
    owner: row.owner,
    repository: row.repository,
    category: row.category,
    key: row.key,
    previousState: safeState(row.previousState, personal),
    newState: safeState(row.newState, personal),
    requestId: row.requestId,
    createdAt: row.createdAt.toISOString(),
  };
}
