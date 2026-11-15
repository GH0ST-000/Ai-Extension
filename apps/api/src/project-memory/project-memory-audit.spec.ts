import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import {
  decodeAuditCursor,
  encodeAuditCursor,
  visibleTo,
} from './audit/project-memory-audit.service';
import {
  auditState,
  isPrivateRule,
  recordMemoryAudit,
  statusEventType,
} from './project-memory-audit';

const row = (over: Record<string, unknown> = {}) =>
  ({
    id: 'mem_1',
    workspaceId: 'ws_1',
    userId: 'u_1',
    visibility: 'workspace',
    provider: 'github',
    owner: 'acme',
    repository: 'app',
    category: 'PROJECT_CONSTRAINT',
    key: 'k',
    status: 'active',
    confidence: 'high',
    valueJson: { summary: 'Rule text', details: { secret: 'never stored' } },
    scopeJson: { type: 'repository' },
    ...over,
  }) as never;

describe('Project Memory audit helpers', () => {
  it('maps every status transition to its event (and no-ops to none)', () => {
    expect(statusEventType('active', 'archived')).toBe('rule_archived');
    expect(statusEventType('active', 'disputed')).toBe('rule_disputed');
    expect(statusEventType('disputed', 'active')).toBe('rule_restored');
    expect(statusEventType('archived', 'active')).toBe('rule_reactivated');
    expect(statusEventType('superseded', 'active')).toBe('rule_reactivated');
    expect(statusEventType('active', 'superseded')).toBe('rule_superseded');
    expect(statusEventType('archived', 'archived')).toBeNull();
  });

  it('shared rules keep text and scope; personal and pre-workspace rules keep status only', () => {
    expect(auditState(row())).toEqual({
      status: 'active',
      confidence: 'high',
      text: 'Rule text',
      scope: { type: 'repository' },
    });
    expect(JSON.stringify(auditState(row()))).not.toContain('never stored'); // details dropped
    for (const personal of [row({ visibility: 'user' }), row({ workspaceId: null })]) {
      expect(isPrivateRule(personal)).toBe(true);
      expect(auditState(personal)).toEqual({ status: 'active', confidence: 'high' });
    }
  });

  it('records personal events as visibility user with the owner as subject, inside the given tx', async () => {
    const tx = {
      user: { findUnique: vi.fn(async () => ({ name: 'Ana' })) },
      projectMemoryAuditEvent: { createMany: vi.fn(async () => ({ count: 1 })) },
    };
    await recordMemoryAudit(
      tx as never,
      'ws_1',
      { userId: 'u_1', type: 'user', requestId: 'req-1' },
      [{ eventType: 'rule_created', reason: 'user_rule', row: row({ visibility: 'user' }) }],
    );
    const data = (
      tx.projectMemoryAuditEvent.createMany.mock.calls[0] as unknown as [
        { data: Record<string, unknown>[] },
      ]
    )[0].data[0]!;
    expect(data).toMatchObject({
      visibility: 'user',
      subjectUserId: 'u_1',
      actorName: 'Ana',
      requestId: 'req-1',
      eventType: 'rule_created',
    });
    expect(JSON.stringify(data)).not.toContain('Rule text');
    await recordMemoryAudit(tx as never, 'ws_1', { userId: 'u_1', type: 'user' }, []);
    expect(tx.projectMemoryAuditEvent.createMany).toHaveBeenCalledTimes(1); // nothing to write
  });

  it('privacy rule is a WHERE clause scoped to the workspace', () => {
    expect(visibleTo('viewer', 'ws_1')).toEqual({
      workspaceId: 'ws_1',
      OR: [{ visibility: 'workspace' }, { visibility: 'user', subjectUserId: 'viewer' }],
    });
  });

  it('cursor round-trips and rejects tampering', () => {
    const at = new Date('2026-11-17T10:00:00.000Z');
    expect(decodeAuditCursor(encodeAuditCursor(at, 'cl123'))).toEqual({
      createdAt: at,
      id: 'cl123',
    });
    for (const bad of ['', 'x', Buffer.from('nope|cl1').toString('base64url')]) {
      expect(() => decodeAuditCursor(bad)).toThrow(BadRequestException);
    }
  });
});
