import { Body, Controller, Delete, Get, HttpCode, Patch, Put, UseGuards } from '@nestjs/common';

import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthRequestUser } from '../auth/jwt.strategy';
import { UpsertJiraConnectionDto } from '../jira/dto/upsert-jira-connection.dto';
import { JiraConnectionService } from '../jira/jira-connection.service';
import { UpdateOnboardingDto } from './dto/update-onboarding.dto';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { UpsertGithubConnectionDto } from './dto/upsert-github-connection.dto';
import { GithubConnectionService } from './github-connection.service';
import { OnboardingService } from './onboarding.service';
import { SettingsService } from './settings.service';

@Controller('settings')
@UseGuards(JwtAuthGuard)
export class SettingsController {
  constructor(
    private readonly settingsService: SettingsService,
    private readonly githubConnectionService: GithubConnectionService,
    private readonly jiraConnectionService: JiraConnectionService,
    private readonly onboardingService: OnboardingService,
  ) {}

  @Get()
  get(@CurrentUser() user: AuthRequestUser) {
    return this.settingsService.getForUser(user.id);
  }

  @Patch()
  update(@CurrentUser() user: AuthRequestUser, @Body() body: UpdateSettingsDto) {
    return this.settingsService.updateForUser(user.id, body);
  }

  @Get('onboarding')
  getOnboarding(@CurrentUser() user: AuthRequestUser) {
    return this.onboardingService.getView(user.id);
  }

  @Patch('onboarding')
  updateOnboarding(@CurrentUser() user: AuthRequestUser, @Body() body: UpdateOnboardingDto) {
    return this.onboardingService.update(user.id, body);
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

  @Get('jira')
  getJira(@CurrentUser() user: AuthRequestUser) {
    return this.jiraConnectionService.getStatus(user.id);
  }

  @Put('jira')
  putJira(@CurrentUser() user: AuthRequestUser, @Body() body: UpsertJiraConnectionDto) {
    return this.jiraConnectionService.upsertConnection(user.id, body);
  }

  @Delete('jira')
  @HttpCode(204)
  async deleteJira(@CurrentUser() user: AuthRequestUser) {
    await this.jiraConnectionService.disconnect(user.id);
  }
}
