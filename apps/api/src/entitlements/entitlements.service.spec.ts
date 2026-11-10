import { describe, expect, it, vi } from 'vitest';

import { EntitlementService, effectivePlanId } from './entitlements.service';

describe('effectivePlanId', () => {
  it('grants the paid plan only while the subscription is active-like', () => {
    expect(effectivePlanId(null)).toBe('free');
    expect(effectivePlanId({ planId: 'pro', status: 'active' })).toBe('pro');
    expect(effectivePlanId({ planId: 'team', status: 'past_due' })).toBe('team');
    expect(effectivePlanId({ planId: 'pro', status: 'cancelled' })).toBe('free');
    expect(effectivePlanId({ planId: 'bogus', status: 'active' })).toBe('free');
  });
});

describe('EntitlementService cache', () => {
  it('does not cache a read that raced with an invalidate (webhook just applied)', async () => {
    let releaseStaleRead!: (row: unknown) => void;
    const findUnique = vi
      .fn()
      // 1st read: started before the webhook committed, resolves late with no row.
      .mockImplementationOnce(() => new Promise((resolve) => (releaseStaleRead = resolve)))
      // 2nd read: after the webhook.
      .mockResolvedValue({ planId: 'pro', status: 'active' });
    const service = new EntitlementService({
      workspaceSubscription: { findUnique },
    } as never);

    const staleRead = service.getPlanId('ws_1');
    service.invalidate('ws_1'); // webhook applied the subscription
    releaseStaleRead(null);
    await expect(staleRead).resolves.toBe('free');

    await expect(service.getPlanId('ws_1')).resolves.toBe('pro');
    expect(findUnique).toHaveBeenCalledTimes(2);
  });

  it('still caches reads that were not interrupted', async () => {
    const findUnique = vi.fn().mockResolvedValue({ planId: 'pro', status: 'active' });
    const service = new EntitlementService({ workspaceSubscription: { findUnique } } as never);

    await service.getPlanId('ws_1');
    await service.getPlanId('ws_1');
    expect(findUnique).toHaveBeenCalledTimes(1);
  });
});
