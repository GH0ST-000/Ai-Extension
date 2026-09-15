import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import type {
  SecurityAuditEvent,
  SecurityAuditEventType,
  SecurityAuditOutcome,
} from '@project-x/types';
import { hashUserIdForTelemetry } from '@project-x/shared';

import type { ApiConfig } from '../config/configuration';
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

  constructor(
    private readonly config: ConfigService<ApiConfig, true>,
    private readonly requestContext: RequestContextService,
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
      workspaceId: input.workspaceId ?? ctx?.workspaceId,
      actorUserIdHash: input.actorUserId ? hashUserIdForTelemetry(input.actorUserId) : undefined,
      emailDomainHash: input.email ? hashEmailDomain(input.email) : undefined,
      ipTruncated: truncateIp(input.ip),
      detail: sanitizeDetail(input.detail),
    };

    this.buffer.push(event);
    if (this.buffer.length > MAX_BUFFER) {
      this.buffer.splice(0, this.buffer.length - MAX_BUFFER);
    }
  }

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
