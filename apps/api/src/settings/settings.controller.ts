import { Body, Controller, Delete, Get, HttpCode, Patch, Put, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthRequestUser } from '../auth/jwt.strategy';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { UpsertGithubConnectionDto } from './dto/upsert-github-connection.dto';
import { GithubConnectionService } from './github-connection.service';
import { SettingsService } from './settings.service';

@Controller('settings')
@UseGuards(JwtAuthGuard)
export class SettingsController {
  constructor(
    private readonly settingsService: SettingsService,
    private readonly githubConnectionService: GithubConnectionService,
  ) {}

  @Get()
  get(@CurrentUser() user: AuthRequestUser) {
    return this.settingsService.getForUser(user.id);
  }

  @Patch()
  update(@CurrentUser() user: AuthRequestUser, @Body() body: UpdateSettingsDto) {
    return this.settingsService.updateForUser(user.id, body);
  }

  @Get('github')
  getGithub(@CurrentUser() user: AuthRequestUser) {
    return this.githubConnectionService.getStatus(user.id);
  }

  @Put('github')
  putGithub(@CurrentUser() user: AuthRequestUser, @Body() body: UpsertGithubConnectionDto) {
    return this.githubConnectionService.upsertToken(user.id, body.token);
  }

  @Delete('github')
  @HttpCode(204)
  async deleteGithub(@CurrentUser() user: AuthRequestUser) {
    await this.githubConnectionService.disconnect(user.id);
  }
}
