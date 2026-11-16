import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { GithubAppModule } from '../github-app/github-app.module';
import { JiraModule } from '../jira/jira.module';
import { GithubConnectionModule } from './github-connection.module';
import { OnboardingService } from './onboarding.service';
import { SettingsController } from './settings.controller';
import { SettingsService } from './settings.service';

@Module({
  imports: [AuthModule, JiraModule, GithubConnectionModule, GithubAppModule],
  controllers: [SettingsController],
  providers: [SettingsService, OnboardingService],
  // GithubConnectionModule is re-exported: modules importing SettingsModule keep getting
  // GithubConnectionService exactly as before.
  exports: [SettingsService, OnboardingService, GithubConnectionModule],
})
export class SettingsModule {}
