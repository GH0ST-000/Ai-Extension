import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildOnboardingView, defaultOnboardingPreferences } from '@project-x/shared';
import { ONBOARDING_VERSION } from '@project-x/types';

import { RequestContextService } from '../observability/request-context.service';
import { OnboardingService } from './onboarding.service';

describe('OnboardingService', () => {
  const githubConnectionService = {
    getStatus: vi.fn(),
  };
  const configService = {
    get: vi.fn().mockReturnValue('http://localhost:3000'),
  };

  function createService(settingsOverrides: Record<string, unknown> = {}) {
    const settingsRow = {
      onboardingVersion: ONBOARDING_VERSION,
      welcomeSeenAt: null,
      onboardingDismissedAt: null,
      firstValueAt: null,
      firstValueType: null,
      dismissedHintIds: [],
      firstWriteEducationSeenAt: null,
      ...settingsOverrides,
    };

    const prisma = {
      userSettings: {
        findUnique: vi.fn().mockResolvedValue(settingsRow),
        create: vi.fn(),
        update: vi.fn().mockResolvedValue(settingsRow),
      },
      workspaceMembership: {
        count: vi.fn().mockResolvedValue(1),
      },
      user: {
        findUnique: vi.fn(),
      },
    };

    const service = new OnboardingService(
      prisma as never,
      githubConnectionService as never,
      configService as never,
    );

    return { service, prisma };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    githubConnectionService.getStatus.mockResolvedValue({ connected: false });
  });

  it('returns derived onboarding view without trusting client github claims', async () => {
    const { service } = createService({ welcomeSeenAt: new Date('2026-09-13T00:00:00.000Z') });
    const view = await service.getView('user_1');
    expect(view.steps.accountReady).toBe(true);
    expect(view.steps.workspaceReady).toBe(true);
    expect(view.steps.githubConnected).toBe(false);
    expect(view.nextStep).toBe('connect_github');
  });

  it('marks first value only once', async () => {
    const { service, prisma } = createService({
      welcomeSeenAt: new Date('2026-09-13T00:00:00.000Z'),
    });
    githubConnectionService.getStatus.mockResolvedValue({ connected: true });

    await service.update('user_1', { firstValueType: 'GENERIC_AI' });
    expect(prisma.userSettings.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          firstValueType: 'GENERIC_AI',
        }),
      }),
    );

    const { service: again, prisma: prisma2 } = createService({
      welcomeSeenAt: new Date('2026-09-13T00:00:00.000Z'),
      firstValueAt: new Date('2026-09-13T01:00:00.000Z'),
      firstValueType: 'GENERIC_AI',
    });
    await again.update('user_1', { firstValueType: 'PR_REVIEW' });
    expect(prisma2.userSettings.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.not.objectContaining({
          firstValueType: 'PR_REVIEW',
        }),
      }),
    );
  });

  it('buildOnboardingView completes after first value without GitHub', () => {
    const view = buildOnboardingView({
      authenticated: true,
      workspaceReady: true,
      githubConnected: false,
      preferences: {
        ...defaultOnboardingPreferences(),
        welcomeSeen: true,
        firstValueAt: '2026-09-13T00:00:00.000Z',
        firstValueType: 'GENERIC_AI',
      },
    });
    expect(view.status).toBe('completed');
    expect(ONBOARDING_VERSION).toBe(1);
  });

  describe('GitHub connection status (personal token OR verified workspace GitHub App)', () => {
    const installations = { getActiveInstallationId: vi.fn() };
    const appTokens = { isAppAuthEnabled: vi.fn() };
    /** Active memberships by workspace id. */
    let memberships: Record<string, string[]>;

    function serviceWithApp() {
      const settingsRow = {
        onboardingVersion: ONBOARDING_VERSION,
        welcomeSeenAt: new Date('2026-09-13T00:00:00.000Z'),
        onboardingDismissedAt: null,
        firstValueAt: null,
        firstValueType: null,
        dismissedHintIds: [],
        firstWriteEducationSeenAt: null,
      };
      const prisma = {
        userSettings: { findUnique: vi.fn().mockResolvedValue(settingsRow) },
        workspaceMembership: {
          count: vi.fn().mockResolvedValue(1),
          findFirst: vi.fn(
            async ({ where }: { where: { userId: string; workspaceId?: string } }) => {
              const ws = where.workspaceId;
              return ws && memberships[ws]?.includes(where.userId) ? { workspaceId: ws } : null;
            },
          ),
        },
        user: { findUnique: vi.fn().mockResolvedValue({ lastWorkspaceId: 'ws_a' }) },
      };
      return new OnboardingService(
        prisma as never,
        githubConnectionService as never,
        configService as never,
        installations as never,
        appTokens as never,
      );
    }

    beforeEach(() => {
      memberships = { ws_a: ['user_1'], ws_b: ['user_2'] };
      installations.getActiveInstallationId.mockReset().mockResolvedValue(null);
      appTokens.isAppAuthEnabled.mockReset().mockReturnValue(true);
    });

    it('a personal token alone counts as connected (existing behavior)', async () => {
      githubConnectionService.getStatus.mockResolvedValue({ connected: true });
      expect((await serviceWithApp().getView('user_1')).steps.githubConnected).toBe(true);
    });

    it('a verified, active App installation on the current workspace counts as connected', async () => {
      installations.getActiveInstallationId.mockImplementation(async (ws: string) =>
        ws === 'ws_a' ? '12345' : null,
      );
      const view = await serviceWithApp().getView('user_1');
      expect(view.steps.githubConnected).toBe(true);
      expect(installations.getActiveInstallationId).toHaveBeenCalledWith('ws_a');
    });

    it('neither token nor installation: not connected', async () => {
      expect((await serviceWithApp().getView('user_1')).steps.githubConnected).toBe(false);
    });

    it('an inactive, unverified or removed installation (no trusted id) is not connected', async () => {
      // getActiveInstallationId returns null for suspended / removed / ownership-unverified rows.
      installations.getActiveInstallationId.mockResolvedValue(null);
      expect((await serviceWithApp().getView('user_1')).steps.githubConnected).toBe(false);
    });

    it('GitHub App auth disabled on this server: an installation does not count', async () => {
      appTokens.isAppAuthEnabled.mockReturnValue(false);
      installations.getActiveInstallationId.mockResolvedValue('12345');
      expect((await serviceWithApp().getView('user_1')).steps.githubConnected).toBe(false);
      expect(installations.getActiveInstallationId).not.toHaveBeenCalled();
    });

    it('workspace isolation: another workspace’s installation never counts', async () => {
      installations.getActiveInstallationId.mockImplementation(async (ws: string) =>
        ws === 'ws_b' ? '999' : null,
      );
      const service = serviceWithApp();
      // Current workspace from the header is one the user belongs to (ws_a): not connected.
      const own = await new RequestContextService().run({ workspaceId: 'ws_a' } as never, () =>
        service.getView('user_1'),
      );
      expect(own.steps.githubConnected).toBe(false);
      // Pointing the header at someone else's workspace (ws_b) is refused, not trusted.
      const foreign = await new RequestContextService().run({ workspaceId: 'ws_b' } as never, () =>
        service.getView('user_1'),
      );
      expect(foreign.steps.githubConnected).toBe(false);
      expect(installations.getActiveInstallationId).not.toHaveBeenCalledWith('ws_b');
    });

    it('installation lookup errors fail safe (not connected) without breaking the view', async () => {
      installations.getActiveInstallationId.mockRejectedValue(new Error('db down'));
      const view = await serviceWithApp().getView('user_1');
      expect(view.steps.githubConnected).toBe(false);
      expect(view.steps.accountReady).toBe(true);
    });

    it('never calls GitHub: the check is database-only', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      installations.getActiveInstallationId.mockResolvedValue('12345');
      await serviceWithApp().getView('user_1');
      expect(fetchSpy).not.toHaveBeenCalled();
      fetchSpy.mockRestore();
    });
  });

  describe('first PR review (server-side review history)', () => {
    function serviceWithReviews(
      findFirst: (args: { where: Record<string, unknown> }) => Promise<unknown>,
      settingsOverrides: Record<string, unknown> = {},
    ) {
      const settingsRow = {
        onboardingVersion: ONBOARDING_VERSION,
        welcomeSeenAt: new Date('2026-09-13T00:00:00.000Z'),
        onboardingDismissedAt: null,
        firstValueAt: null,
        firstValueType: null,
        dismissedHintIds: [],
        firstWriteEducationSeenAt: null,
        ...settingsOverrides,
      };
      const prisma = {
        userSettings: { findUnique: vi.fn().mockResolvedValue(settingsRow) },
        workspaceMembership: { count: vi.fn().mockResolvedValue(1) },
        user: { findUnique: vi.fn() },
        prReviewReport: { findFirst: vi.fn(findFirst) },
      };
      return {
        prisma,
        service: new OnboardingService(
          prisma as never,
          githubConnectionService as never,
          configService as never,
        ),
      };
    }

    it('a completed or partial review of this user counts', async () => {
      const { service, prisma } = serviceWithReviews(async () => ({ id: 'r1' }));
      expect((await service.getView('user_1')).firstPrReviewCompleted).toBe(true);
      expect(prisma.prReviewReport.findFirst).toHaveBeenCalledWith({
        where: { userId: 'user_1', status: { in: ['completed', 'partial'] } },
        select: { id: true },
      });
    });

    it('no successful review (none, or failed only) does not count', async () => {
      const { service } = serviceWithReviews(async () => null);
      expect((await service.getView('user_1')).firstPrReviewCompleted).toBe(false);
    });

    it('a generic first action (Ask AI) is not evidence of a PR review', async () => {
      const { service } = serviceWithReviews(async () => null, {
        firstValueAt: new Date('2026-11-01T00:00:00.000Z'),
        firstValueType: 'GENERIC_AI',
      });
      const view = await service.getView('user_1');
      expect(view.steps.firstActionCompleted).toBe(true); // existing signal unchanged
      expect(view.firstPrReviewCompleted).toBe(false);
    });

    it('a client-reported PR_REVIEW first value alone is not trusted', async () => {
      const { service } = serviceWithReviews(async () => null, {
        firstValueAt: new Date('2026-11-01T00:00:00.000Z'),
        firstValueType: 'PR_REVIEW',
      });
      expect((await service.getView('user_1')).firstPrReviewCompleted).toBe(false);
    });

    it('a history read failure keeps the guidance (false) without breaking the view', async () => {
      const { service } = serviceWithReviews(async () => {
        throw new Error('db down');
      });
      const view = await service.getView('user_1');
      expect(view.firstPrReviewCompleted).toBe(false);
      expect(view.steps.accountReady).toBe(true);
    });
  });
});
