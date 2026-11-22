import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

import { RATE_LIMIT_KEY, RateLimitGuard } from '../common/security/rate-limit.guard';
import { WORKSPACE_CREATE_LIMIT, WorkspacesController } from './workspaces.controller';

describe('N-10: workspace creation is rate limited per user', () => {
  it('POST /workspaces declares the creation limit', () => {
    const handler = WorkspacesController.prototype.create;
    expect(Reflect.getMetadata(RATE_LIMIT_KEY, handler)).toEqual(WORKSPACE_CREATE_LIMIT);
  });

  it('concurrent creations beyond the limit are refused with 429', async () => {
    const counts = new Map<string, number>();
    const redis = {
      status: 'ready',
      incr: async (key: string) => {
        counts.set(key, (counts.get(key) ?? 0) + 1);
        return counts.get(key)!;
      },
      expire: async () => 1,
    };
    const guard = new RateLimitGuard(new Reflector(), redis as never);
    const ctx = {
      getHandler: () => WorkspacesController.prototype.create,
      getClass: () => WorkspacesController,
      switchToHttp: () => ({ getRequest: () => ({ user: { id: 'u1' }, headers: {} }) }),
    } as never;
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => guard.canActivate(ctx)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(
      WORKSPACE_CREATE_LIMIT.limit,
    );
    expect(
      results
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .every((r) => (r.reason as { getStatus(): number }).getStatus() === 429),
    ).toBe(true);
  });
});
