import { Controller, Get, Query, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';

import { Public } from '../auth/public.decorator';
import type { ApiConfig } from '../config/configuration';
import { GithubAppInstallationService } from './github-app-installation.service';

/**
 * Browser redirect from GitHub during installation. Public (GitHub cannot send our session):
 * every value it carries is treated as untrusted and checked server-side.
 *
 * 1. Setup URL  → `GET /api/integrations/github-app/setup?installation_id&state`
 *    Does not link anything; starts GitHub user authorization for ownership verification.
 * 2. GitHub's user authorization then returns to the DASHBOARD (Callback URL
 *    `<APP_BASE_URL>/app/integrations/github-app/callback`), which completes the link through the
 *    authenticated `POST /api/workspaces/:workspaceId/integrations/github-app/verify`.
 */
@Public()
@Controller('integrations/github-app')
export class GithubAppSetupController {
  constructor(
    private readonly installations: GithubAppInstallationService,
    private readonly config: ConfigService<ApiConfig, true>,
  ) {}

  private settingsUrl(result: 'connected' | 'error'): string {
    const appBaseUrl = this.config.get('appBaseUrl', { infer: true });
    return `${appBaseUrl}/app/settings?githubApp=${result}`;
  }

  /** GitHub App "Setup URL". */
  @Get('setup')
  async setup(
    @Query('installation_id') installationId: string | undefined,
    @Query('state') state: string | undefined,
    @Res() res: Response,
  ) {
    if (!installationId?.trim() || !state?.trim()) {
      res.redirect(this.settingsUrl('error'));
      return;
    }
    try {
      const { authorizeUrl } = await this.installations.completeSetupFromCallback({
        installationId: installationId.trim(),
        state: state.trim(),
      });
      res.redirect(authorizeUrl);
    } catch {
      res.redirect(this.settingsUrl('error'));
    }
  }
}
