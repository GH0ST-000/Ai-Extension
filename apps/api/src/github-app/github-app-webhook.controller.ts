import { Controller, Headers, Post, Req, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';

import type { ApiConfig } from '../config/configuration';
import { GithubAppInstallationService } from './github-app-installation.service';
import { GithubAppApiClient } from './github-app-api.client';
import { verifyGitHubWebhookSignature } from './github-app-webhook-signature';

type InstallationWebhookPayload = {
  action?: string;
  installation?: {
    id?: number;
    account?: { login?: string; type?: string };
    repository_selection?: string;
    permissions?: Record<string, string>;
    suspended_at?: string | null;
  };
};

@Controller('webhooks')
export class GithubAppWebhookController {
  constructor(
    private readonly config: ConfigService<ApiConfig, true>,
    private readonly installations: GithubAppInstallationService,
    private readonly appApi: GithubAppApiClient,
  ) {}

  @Post('github-app')
  async handle(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('x-hub-signature-256') signature?: string,
    @Headers('x-github-event') event?: string,
  ) {
    const secret = this.config.get('githubApp.webhookSecret', { infer: true });
    const raw =
      req.rawBody ??
      (Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {})));

    if (!secret || !verifyGitHubWebhookSignature(raw, signature, secret)) {
      throw new UnauthorizedException('Invalid GitHub webhook signature.');
    }

    const payload = JSON.parse(raw.toString('utf8')) as InstallationWebhookPayload;
    const installationId = payload.installation?.id;
    if (!installationId) {
      return { ok: true, ignored: true };
    }

    const id = String(installationId);

    if (event === 'installation') {
      const action = payload.action;
      if (action === 'deleted') {
        await this.installations.markInstallationRemoved(id);
        return { ok: true };
      }

      if (action === 'suspend') {
        await this.installations.markInstallationSuspended(id, true);
        return { ok: true };
      }

      if (action === 'unsuspend') {
        await this.installations.markInstallationSuspended(id, false);
        return { ok: true };
      }

      if (action === 'created' || action === 'new_permissions_accepted') {
        const remote = await this.appApi.fetchInstallation(id);
        const existing = await this.installations.getWorkspaceIdForInstallation(id);
        if (existing) {
          await this.installations.upsertFromGitHubInstallation({
            workspaceId: existing,
            installation: remote,
          });
        }
        return { ok: true };
      }
    }

    return { ok: true, ignored: true };
  }
}
