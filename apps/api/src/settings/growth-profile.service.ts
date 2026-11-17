import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  MARKETING_CONSENT_VERSION,
  PRIMARY_GOALS,
  PROFESSIONAL_ROLES,
  USAGE_INTENTS,
  type MarketingConsentSource,
  type PrimaryGoal,
  type ProfessionalRole,
  type UsageIntent,
  type UserGrowthProfile,
} from '@project-x/types';

import { PrismaService } from '../prisma/prisma.service';
import type { UpdateGrowthProfileDto } from './dto/growth-profile.dto';

const SELECT = {
  professionalRole: true,
  usageIntent: true,
  primaryGoal: true,
  profileCompletedAt: true,
  profileSkippedAt: true,
  marketingEmailConsent: true,
  marketingConsentUpdatedAt: true,
} satisfies Prisma.UserSettingsSelect;

type Row = Prisma.UserSettingsGetPayload<{ select: typeof SELECT }>;

function pick<T extends string>(allowed: readonly T[], value: string | null): T | null {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : null;
}

function toProfile(row: Row): UserGrowthProfile {
  return {
    professionalRole: pick<ProfessionalRole>(PROFESSIONAL_ROLES, row.professionalRole),
    usageIntent: pick<UsageIntent>(USAGE_INTENTS, row.usageIntent),
    primaryGoal: pick<PrimaryGoal>(PRIMARY_GOALS, row.primaryGoal),
    profileCompletedAt: row.profileCompletedAt?.toISOString() ?? null,
    profileSkippedAt: row.profileSkippedAt?.toISOString() ?? null,
    marketingEmailConsent: row.marketingEmailConsent,
    marketingConsentUpdatedAt: row.marketingConsentUpdatedAt?.toISOString() ?? null,
  };
}

/**
 * The signed-in user's optional growth profile and marketing email consent. Every method acts
 * on the authenticated user id only. Segmentation data — never a workspace role.
 */
@Injectable()
export class GrowthProfileService {
  constructor(private readonly prisma: PrismaService) {}

  async get(userId: string): Promise<UserGrowthProfile> {
    const row = await this.prisma.userSettings.upsert({
      where: { userId },
      update: {},
      create: { userId },
      select: SELECT,
    });
    return toProfile(row);
  }

  /** Partial update; saving answers (even one) marks the questions as completed. */
  async update(userId: string, input: UpdateGrowthProfileDto): Promise<UserGrowthProfile> {
    const data: Prisma.UserSettingsUpdateInput = {};
    if (input.professionalRole !== undefined) data.professionalRole = input.professionalRole;
    if (input.usageIntent !== undefined) data.usageIntent = input.usageIntent;
    if (input.primaryGoal !== undefined) data.primaryGoal = input.primaryGoal;
    const current = await this.prisma.userSettings.upsert({
      where: { userId },
      update: {},
      create: { userId },
      select: { profileCompletedAt: true },
    });
    const row = await this.prisma.userSettings.update({
      where: { userId },
      data: { ...data, ...(current.profileCompletedAt ? {} : { profileCompletedAt: new Date() }) },
      select: SELECT,
    });
    return toProfile(row);
  }

  /** "Skip for now": remembered so the questions are not shown again automatically. */
  async skip(userId: string): Promise<UserGrowthProfile> {
    const current = await this.prisma.userSettings.upsert({
      where: { userId },
      update: {},
      create: { userId },
      select: { profileCompletedAt: true, profileSkippedAt: true },
    });
    if (current.profileCompletedAt || current.profileSkippedAt) return this.get(userId);
    const row = await this.prisma.userSettings.update({
      where: { userId },
      data: { profileSkippedAt: new Date() },
      select: SELECT,
    });
    return toProfile(row);
  }

  /**
   * Grant or withdraw marketing email consent. A change is stored with an evidence row
   * (granted, source, wording version, time) in the same transaction; re-sending the current
   * state records nothing new. Transactional email is never affected.
   */
  async setMarketingConsent(
    userId: string,
    granted: boolean,
    source: MarketingConsentSource = 'settings',
  ): Promise<UserGrowthProfile> {
    const row = await this.prisma.$transaction(async (tx) => {
      const current = await tx.userSettings.upsert({
        where: { userId },
        update: {},
        create: { userId },
        select: { marketingEmailConsent: true },
      });
      if (current.marketingEmailConsent === granted) {
        return tx.userSettings.findUniqueOrThrow({ where: { userId }, select: SELECT });
      }
      const now = new Date();
      await tx.marketingConsentEvent.create({
        data: { userId, granted, source, policyVersion: MARKETING_CONSENT_VERSION, createdAt: now },
      });
      return tx.userSettings.update({
        where: { userId },
        data: { marketingEmailConsent: granted, marketingConsentUpdatedAt: now },
        select: SELECT,
      });
    });
    return toProfile(row);
  }
}
