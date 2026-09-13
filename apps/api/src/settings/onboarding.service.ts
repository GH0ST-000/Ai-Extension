import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { buildOnboardingView, defaultOnboardingPreferences } from '@project-x/shared';
import {
  FIRST_VALUE_TYPES,
  ONBOARDING_VERSION,
  type FirstValueType,
  type OnboardingPreferences,
  type OnboardingView,
} from '@project-x/types';

import { PrismaService } from '../prisma/prisma.service';
import { GithubConnectionService } from './github-connection.service';
import type { UpdateOnboardingDto } from './dto/update-onboarding.dto';

type SettingsRow = {
  onboardingVersion: number;
  welcomeSeenAt: Date | null;
  onboardingDismissedAt: Date | null;
  firstValueAt: Date | null;
  firstValueType: string | null;
  dismissedHintIds: unknown;
  firstWriteEducationSeenAt: Date | null;
};

function parseHintIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim())
    .slice(0, 100);
}

function parseFirstValueType(raw: string | null): FirstValueType | null {
  if (!raw) return null;
  return (FIRST_VALUE_TYPES as readonly string[]).includes(raw) ? (raw as FirstValueType) : null;
}

@Injectable()
export class OnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly githubConnectionService: GithubConnectionService,
    private readonly configService: ConfigService,
  ) {}

  async getView(userId: string): Promise<OnboardingView> {
    const settings = await this.ensureSettings(userId);
    const [membershipCount, github] = await Promise.all([
      this.prisma.workspaceMembership.count({
        where: { userId, status: 'active' },
      }),
      this.githubConnectionService.getStatus(userId),
    ]);

    return buildOnboardingView({
      authenticated: true,
      workspaceReady: membershipCount > 0,
      githubConnected: github.connected,
      preferences: this.toPreferences(settings),
      dashboardBaseUrl:
        this.configService.get<string>('appBaseUrl') ||
        process.env.APP_BASE_URL ||
        'http://localhost:3000',
    });
  }

  async update(userId: string, input: UpdateOnboardingDto): Promise<OnboardingView> {
    const current = await this.ensureSettings(userId);
    const hints = parseHintIds(current.dismissedHintIds);
    const nextHints =
      input.dismissHintId && !hints.includes(input.dismissHintId)
        ? [...hints, input.dismissHintId].slice(0, 100)
        : hints;

    const firstValueType =
      !current.firstValueAt && input.firstValueType ? input.firstValueType : undefined;

    await this.prisma.userSettings.update({
      where: { userId },
      data: {
        onboardingVersion: Math.max(current.onboardingVersion || 1, ONBOARDING_VERSION),
        ...(input.welcomeSeen === true && !current.welcomeSeenAt
          ? { welcomeSeenAt: new Date() }
          : {}),
        ...(input.dismiss === true && !current.onboardingDismissedAt
          ? { onboardingDismissedAt: new Date() }
          : {}),
        ...(firstValueType ? { firstValueAt: new Date(), firstValueType } : {}),
        ...(input.dismissHintId ? { dismissedHintIds: nextHints } : {}),
        ...(input.firstWriteEducationSeen === true && !current.firstWriteEducationSeenAt
          ? { firstWriteEducationSeenAt: new Date() }
          : {}),
      },
    });

    return this.getView(userId);
  }

  private toPreferences(settings: SettingsRow): OnboardingPreferences {
    const base = defaultOnboardingPreferences(settings.onboardingVersion || ONBOARDING_VERSION);
    return {
      ...base,
      version: settings.onboardingVersion || ONBOARDING_VERSION,
      welcomeSeen: Boolean(settings.welcomeSeenAt),
      dismissedAt: settings.onboardingDismissedAt?.toISOString() ?? null,
      firstValueAt: settings.firstValueAt?.toISOString() ?? null,
      firstValueType: parseFirstValueType(settings.firstValueType),
      dismissedHintIds: parseHintIds(settings.dismissedHintIds),
      firstWriteEducationSeen: Boolean(settings.firstWriteEducationSeenAt),
    };
  }

  private async ensureSettings(userId: string): Promise<SettingsRow> {
    const existing = await this.prisma.userSettings.findUnique({
      where: { userId },
      select: {
        onboardingVersion: true,
        welcomeSeenAt: true,
        onboardingDismissedAt: true,
        firstValueAt: true,
        firstValueType: true,
        dismissedHintIds: true,
        firstWriteEducationSeenAt: true,
      },
    });
    if (existing) {
      return existing;
    }

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found.');
    }

    return this.prisma.userSettings.create({
      data: { userId },
      select: {
        onboardingVersion: true,
        welcomeSeenAt: true,
        onboardingDismissedAt: true,
        firstValueAt: true,
        firstValueType: true,
        dismissedHintIds: true,
        firstWriteEducationSeenAt: true,
      },
    });
  }
}
