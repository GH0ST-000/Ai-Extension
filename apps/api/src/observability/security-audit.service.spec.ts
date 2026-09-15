import { describe, expect, it, vi } from 'vitest';

import { SecurityAuditService } from './security-audit.service';
import { RequestContextService } from './request-context.service';

describe('SecurityAuditService', () => {
  const config = {
    get: vi.fn((key: string) => {
      if (key === 'service') return 'api';
      if (key === 'release') return 'test-release';
      if (key === 'nodeEnv') return 'test';
      return undefined;
    }),
  };

  it('exports NDJSON and respects since filter', () => {
    const requestContext = new RequestContextService();
    const svc = new SecurityAuditService(config as never, requestContext);

    requestContext.run({ requestId: 'req_sec001' }, () => {
      svc.record({
        type: 'auth.login.failure',
        outcome: 'failure',
        email: 'user@example.com',
        ip: '203.0.113.10',
      });
    });

    const all = svc.exportNdjson({ limit: 10 });
    expect(all.split('\n').filter(Boolean).length).toBe(1);
    const line = JSON.parse(all.trim()) as Record<string, unknown>;
    expect(line.type).toBe('auth.login.failure');
    expect(line.requestId).toBe('req_sec001');
    expect(line.emailDomainHash).toBeTruthy();
    expect(JSON.stringify(line)).not.toContain('user@example.com');

    const future = svc.exportNdjson({
      since: new Date(Date.now() + 60_000),
      limit: 10,
    });
    expect(future.trim()).toBe('');
  });
});
