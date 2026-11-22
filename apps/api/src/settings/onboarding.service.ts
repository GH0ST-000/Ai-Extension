import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { buildOnboardingView, defaultOnboardingPreferences } from '@project-x/shared';
import {
  FIRST_VALUE_TYPES,
  ONBOARDING_VERSION,
  type FirstValueType,
  type OnboardingPreferences,
  type OnboardingView,
} from '@project-x/types';

import { GithubAppInstallationService } from '../github-app/github-app-installation.service';
import { GithubAppTokenService } from '../github-app/github-app-token.service';
import { PrismaService } from '../prisma/prisma.service';
import { resolveWorkspaceIdForUser } from '../workspaces/resolve-workspace-id';
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
    // Optional so unit tests can build the service without GitHub App wiring.
    @Optional() private readonly installations?: GithubAppInstallationService,
    @Optional() private readonly appTokens?: GithubAppTokenService,
  ) {}

  async getView(userId: string): Promise<OnboardingView> {
    const settings = await this.ensureSettings(userId);
    const [membershipCount, github, workspaceApp, firstPrReviewCompleted] = await Promise.all([
      this.prisma.workspaceMembership.count({
        where: { userId, status: 'active' },
      }),
      this.githubConnectionService.getStatus(userId),
      this.hasWorkspaceGithubApp(userId),
      this.hasSuccessfulPrReview(userId),
    ]);

    const view = buildOnboardingView({
      authenticated: true,
      workspaceReady: membershipCount > 0,
      // A personal token OR a verified, active GitHub App installation on the current
      // workspace both give PR reviews GitHub access (same precedence as GithubAccessService).
      githubConnected: github.connected || workspaceApp,
      preferences: this.toPreferences(settings),
      dashboardBaseUrl:
        this.configService.get<string>('appBaseUrl') ||
        process.env.APP_BASE_URL ||
        'http://localhost:3000',
    });
    return { ...view, firstPrReviewCompleted };
  }

  /**
   * Reliable, server-side evidence of a first PR review: a saved report of this user's own
   * review that delivered results (completed or partial). Generic AI actions and client-reported
   * "first value" markers do not count. One indexed lookup (pr_review_reports.user_id); a read
   * failure is treated as "not yet" so the guidance stays visible.
   */
  private async hasSuccessfulPrReview(userId: string): Promise<boolean> {
    try {
      const report = await this.prisma.prReviewReport.findFirst({
        where: { userId, status: { in: ['completed', 'partial'] } },
        select: { id: true },
      });
      return report !== null;
    } catch {
      return false;
    }
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

  /**
   * True when the user's current workspace (X-Workspace-Id, else their last workspace; active
   * membership required) has a GitHub App installation that is active AND ownership-verified —
   * the same check that gates installation tokens. Database only: no GitHub API call. Any
   * failure (no membership, unknown workspace, App disabled) counts as not connected.
   */
  private async hasWorkspaceGithubApp(userId: string): Promise<boolean> {
    if (!this.installations || !this.appTokens?.isAppAuthEnabled()) return false;
    try {
      const workspaceId = await resolveWorkspaceIdForUser(
        this.prisma,
        userId,
        undefined,
        'workspace:read',
      );
      return (await this.installations.getActiveInstallationId(workspaceId)) !== null;
    } catch {
      return false;
    }
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
