import { Controller, Get, Query, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';

import type { ApiConfig } from '../config/configuration';
import { GithubAppInstallationService } from './github-app-installation.service';

@Controller('integrations/github-app')
export class GithubAppSetupController {
  constructor(
    private readonly installations: GithubAppInstallationService,
    private readonly config: ConfigService<ApiConfig, true>,
  ) {}

  /**
   * GitHub App setup URL callback (Configure → Setup URL in the GitHub App settings).
   */
  @Get('setup')
  async setup(
    @Query('installation_id') installationId: string | undefined,
    @Query('state') state: string | undefined,
    @Res() res: Response,
  ) {
    const appBaseUrl = this.config.get('appBaseUrl', { infer: true });
    const settingsPath = '/app/settings';

    if (!installationId?.trim() || !state?.trim()) {
      res.redirect(`${appBaseUrl}${settingsPath}?githubApp=error`);
      return;
    }

    try {
      await this.installations.completeSetupFromCallback({
        installationId: installationId.trim(),
        state: state.trim(),
      });
      res.redirect(`${appBaseUrl}${settingsPath}?githubApp=connected`);
    } catch {
      res.redirect(`${appBaseUrl}${settingsPath}?githubApp=error`);
    }
  }
}
