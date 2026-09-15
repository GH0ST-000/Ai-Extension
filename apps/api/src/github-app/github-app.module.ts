import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { SettingsModule } from '../settings/settings.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import { GithubAccessService } from './github-access.service';
import { GithubAppApiClient } from './github-app-api.client';
import { GithubAppController } from './github-app.controller';
import { GithubAppInstallationService } from './github-app-installation.service';
import { GithubAppSetupController } from './github-app-setup.controller';
import { GithubAppTokenService } from './github-app-token.service';
import { GithubAppWebhookController } from './github-app-webhook.controller';

@Module({
  imports: [AuthModule, SettingsModule, WorkspacesModule],
  controllers: [GithubAppController, GithubAppSetupController, GithubAppWebhookController],
  providers: [
    GithubAppTokenService,
    GithubAppApiClient,
    GithubAppInstallationService,
    GithubAccessService,
  ],
  exports: [GithubAccessService, GithubAppInstallationService, GithubAppTokenService],
})
export class GithubAppModule {}
