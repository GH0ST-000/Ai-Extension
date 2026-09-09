import { Injectable, NotFoundException } from '@nestjs/common';

import type { UserSettings as UserSettingsDto } from '@project-x/types';

import { PrismaService } from '../prisma/prisma.service';
import type { UpdateSettingsDto } from './dto/update-settings.dto';

@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async getForUser(userId: string): Promise<UserSettingsDto> {
    const settings = await this.ensureSettings(userId);
    return this.toDto(settings);
  }

  async updateForUser(userId: string, input: UpdateSettingsDto): Promise<UserSettingsDto> {
    await this.ensureSettings(userId);

    const settings = await this.prisma.userSettings.update({
      where: { userId },
      data: {
        ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
        ...(input.responseStyle !== undefined ? { responseStyle: input.responseStyle } : {}),
        ...(input.includePageContext !== undefined
          ? { includePageContext: input.includePageContext }
          : {}),
      },
    });

    return this.toDto(settings);
  }

  private async ensureSettings(userId: string) {
    const existing = await this.prisma.userSettings.findUnique({
      where: { userId },
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
    });
  }

  private toDto(settings: {
    maxOutputTokens: number;
    responseStyle: 'CONCISE' | 'BALANCED' | 'DETAILED';
    includePageContext: boolean;
  }): UserSettingsDto {
    return {
      maxOutputTokens: settings.maxOutputTokens,
      responseStyle: settings.responseStyle,
      includePageContext: settings.includePageContext,
    };
  }
}
