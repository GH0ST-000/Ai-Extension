import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import type {
  SecurityAuditEvent,
  SecurityAuditEventType,
  SecurityAuditOutcome,
} from '@project-x/types';
import { hashUserIdForTelemetry } from '@project-x/shared';

import type { ApiConfig } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import { RequestContextService } from './request-context.service';

const MAX_BUFFER = 5_000;
const MAX_EXPORT = 5_000;

export type RecordSecurityAuditInput = {
  type: SecurityAuditEventType;
  outcome: SecurityAuditOutcome;
  actorUserId?: string;
  email?: string;
  workspaceId?: string;
  ip?: string | null;
  detail?: string;
};

@Injectable()
export class SecurityAuditService {
  private readonly buffer: SecurityAuditEvent[] = [];
  private readonly logger = new Logger(SecurityAuditService.name);

  constructor(
    private readonly config: ConfigService<ApiConfig, true>,
    private readonly requestContext: RequestContextService,
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  record(input: RecordSecurityAuditInput): void {
    const ctx = this.requestContext.get();
    const event: SecurityAuditEvent = {
      id: `sec_${randomUUID().replace(/-/g, '')}`,
      type: input.type,
      timestamp: new Date().toISOString(),
      service: this.config.get('service', { infer: true }),
      release: this.config.get('release', { infer: true }),
      environment: this.config.get('nodeEnv', { infer: true }),
      outcome: input.outcome,
      requestId: ctx?.requestId,
      // Adversarial N8: only a workspace id the caller authorized — never the raw,
      // unverified X-Workspace-Id header from the request context.
      workspaceId: input.workspaceId,
      actorUserIdHash: input.actorUserId ? hashUserIdForTelemetry(input.actorUserId) : undefined,
      emailDomainHash: input.email ? hashEmailDomain(input.email) : undefined,
      ipTruncated: truncateIp(input.ip),
      detail: sanitizeDetail(input.detail),
    };

    this.buffer.push(event);
    if (this.buffer.length > MAX_BUFFER) {
      this.buffer.splice(0, this.buffer.length - MAX_BUFFER);
    }
    this.persist(event);
  }

  /**
   * N-18: durable copy (security_audit_events), so the trail survives restarts and is shared
   * by every instance. Asynchronous and best effort: auditing never blocks or breaks the
   * operation it records; a failed write is logged (event type only). The event holds safe
   * metadata only — the HMAC actor reference, workspace id, sanitized ≤256-char detail.
   */
  private persist(event: SecurityAuditEvent): void {
    if (!this.prisma) return;
    void this.prisma.securityAuditEventRecord
      .create({
        data: {
          id: event.id,
          type: event.type,
          outcome: event.outcome,
          workspaceId: event.workspaceId ?? null,
          actorUserIdHash: event.actorUserIdHash ?? null,
          requestId: event.requestId ?? null,
          detail: event.detail ?? null,
          service: event.service,
          release: event.release,
          environment: event.environment,
          createdAt: new Date(event.timestamp),
        },
      })
      .catch((error: unknown) =>
        this.logger.error({
          msg: 'security_audit.persist_failed',
          type: event.type,
          errorName: error instanceof Error ? error.name : 'unknown',
        }),
      );
  }

  /**
   * F-29: the SIEM export reads the DURABLE trail (security_audit_events), not this process's
   * memory — so it is complete across restarts and identical on every instance. With `since`
   * it returns the OLDEST events from that time on; without, the most recent `limit` events.
   * Oldest first.
   *
   * Paging: pass `afterId` (the `id` of the last event received) together with `since` (its
   * `timestamp`). The page then starts strictly after that event in (timestamp, id) order, so
   * events that share a timestamp are neither repeated nor skipped, and a page boundary inside
   * one millisecond cannot loop. Events are written asynchronously with the application's
   * clock, so a consumer should re-read a short overlap (a few seconds) to pick up an event
   * that was committed late.
   *
   * Falls back to the in-process buffer only when there is no database handle or the query
   * fails (the export of a degraded node is then partial, and says so in the log).
   */
  async exportPersistedNdjson(options: {
    since?: Date;
    afterId?: string;
    limit: number;
  }): Promise<string> {
    const limit = Math.min(Math.max(1, options.limit), MAX_EXPORT);
    if (!this.prisma) return this.exportNdjson(options);
    try {
      const where = !options.since
        ? undefined
        : options.afterId
          ? {
              OR: [
                { createdAt: { gt: options.since } },
                { createdAt: options.since, id: { gt: options.afterId } },
              ],
            }
          : { createdAt: { gte: options.since } };
      const rows = await this.prisma.securityAuditEventRecord.findMany({
        ...(where ? { where } : {}),
        orderBy: options.since
          ? [{ createdAt: 'asc' }, { id: 'asc' }]
          : [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
      });
      if (!options.since) rows.reverse();
      if (rows.length === 0) return '';
      return `${rows
        .map((row) =>
          JSON.stringify({
            id: row.id,
            type: row.type,
            timestamp: row.createdAt.toISOString(),
            service: row.service,
            release: row.release,
            environment: row.environment,
            outcome: row.outcome,
            ...(row.requestId ? { requestId: row.requestId } : {}),
            ...(row.workspaceId ? { workspaceId: row.workspaceId } : {}),
            ...(row.actorUserIdHash ? { actorUserIdHash: row.actorUserIdHash } : {}),
            ...(row.detail ? { detail: row.detail } : {}),
          }),
        )
        .join('\n')}\n`;
    } catch (error) {
      this.logger.error({
        msg: 'security_audit.export_fallback_to_memory',
        errorName: error instanceof Error ? error.name : 'unknown',
      });
      return this.exportNdjson(options);
    }
  }

  /** In-process buffer only (this instance, since its last start). See exportPersistedNdjson. */
  exportNdjson(options: { since?: Date; limit: number }): string {
    const limit = Math.min(Math.max(1, options.limit), MAX_EXPORT);
    let events = this.buffer;

    if (options.since) {
      const sinceMs = options.since.getTime();
      events = events.filter((e) => Date.parse(e.timestamp) >= sinceMs);
    }

    const slice = events.slice(-limit);
    if (slice.length === 0) {
      return '';
    }
    return `${slice.map((e) => JSON.stringify(e)).join('\n')}\n`;
  }
}

function hashEmailDomain(email: string): string {
  const domain = email.toLowerCase().split('@')[1]?.trim();
  if (!domain) return 'unknown';
  return createHash('sha256').update(`domain:${domain}`).digest('hex').slice(0, 16);
}

function truncateIp(ip: string | null | undefined): string | undefined {
  if (!ip) return undefined;
  const trimmed = ip.trim();
  if (trimmed.length <= 64) return trimmed;
  return trimmed.slice(0, 64);
}

function sanitizeDetail(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  const trimmed = detail.trim();
  if (!trimmed || trimmed.length > 256) {
    return trimmed ? trimmed.slice(0, 256) : undefined;
  }
  return trimmed;
}
