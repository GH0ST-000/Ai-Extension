import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildOnboardingView, defaultOnboardingPreferences } from '@project-x/shared';
import { ONBOARDING_VERSION } from '@project-x/types';

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
});
