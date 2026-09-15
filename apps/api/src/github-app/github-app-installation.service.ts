import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import type { GitHubAppInstallationStatus, WorkspaceGitHubAppStatus } from '@project-x/types';

import { encryptSecret } from '../common/crypto/secret-box';
import type { ApiConfig } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { GithubAppApiClient } from './github-app-api.client';
import { GithubAppTokenService } from './github-app-token.service';

const INSTALL_STATE_PREFIX = 'gh:app:install-state:';
const INSTALL_STATE_TTL_SECONDS = 15 * 60;

type InstallStatePayload = {
  workspaceId: string;
  userId: string;
};

@Injectable()
export class GithubAppInstallationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService<ApiConfig, true>,
    private readonly appTokens: GithubAppTokenService,
    private readonly appApi: GithubAppApiClient,
  ) {}

  async getStatusForWorkspace(workspaceId: string): Promise<WorkspaceGitHubAppStatus> {
    const appConfigured = this.appTokens.isAppAuthEnabled();
    const row = await this.prisma.gitHubAppInstallation.findUnique({
      where: { workspaceId },
    });

    if (!row || row.status === 'removed') {
      return { appConfigured, connected: false };
    }

    return {
      appConfigured,
      connected: row.status === 'active',
      installationId: row.installationId,
      accountLogin: row.accountLogin,
      accountType: row.accountType,
      repositorySelection: row.repositorySelection,
      status: row.status as GitHubAppInstallationStatus,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async startInstall(
    workspaceId: string,
    userId: string,
  ): Promise<{ installUrl: string; state: string }> {
    this.assertAppConfigured();

    const state = randomBytes(24).toString('hex');
    const payload: InstallStatePayload = { workspaceId, userId };
    await this.redis.set(
      `${INSTALL_STATE_PREFIX}${state}`,
      JSON.stringify(payload),
      'EX',
      INSTALL_STATE_TTL_SECONDS,
    );

    const slug = this.config.get('githubApp.slug', { infer: true });
    const params = new URLSearchParams({ state });
    const installUrl = `https://github.com/apps/${encodeURIComponent(slug)}/installations/new?${params.toString()}`;

    return { installUrl, state };
  }

  async completeSetupFromCallback(input: {
    installationId: string;
    state: string;
  }): Promise<WorkspaceGitHubAppStatus> {
    this.assertAppConfigured();

    const installationId = input.installationId.trim();
    const state = input.state.trim();
    if (!installationId || !state) {
      throw new BadRequestException('installation_id and state are required.');
    }

    const stateKey = `${INSTALL_STATE_PREFIX}${state}`;
    const rawState = await this.redis.get(stateKey);
    if (!rawState) {
      throw new BadRequestException(
        'Install session expired or invalid state. Start install again.',
      );
    }
    await this.redis.del(stateKey);

    let parsed: InstallStatePayload;
    try {
      parsed = JSON.parse(rawState) as InstallStatePayload;
    } catch {
      throw new BadRequestException('Invalid install state payload.');
    }

    const remote = await this.appApi.fetchInstallation(installationId);
    if (String(remote.id) !== installationId) {
      throw new BadRequestException('Installation id mismatch.');
    }

    return this.upsertFromGitHubInstallation({
      workspaceId: parsed.workspaceId,
      installedByUserId: parsed.userId,
      installation: remote,
    });
  }

  async upsertFromGitHubInstallation(input: {
    workspaceId: string;
    installedByUserId?: string | null;
    installation: {
      id: number;
      account?: { login?: string; type?: string };
      repository_selection?: string;
      permissions?: Record<string, string>;
      suspended_at?: string | null;
    };
  }): Promise<WorkspaceGitHubAppStatus> {
    const login = input.installation.account?.login?.trim();
    const accountType = input.installation.account?.type?.trim();
    if (!login || !accountType) {
      throw new ServiceUnavailableException('GitHub installation is missing account metadata.');
    }

    const status: GitHubAppInstallationStatus = input.installation.suspended_at
      ? 'suspended'
      : 'active';

    const metadataCiphertext = input.installation.permissions
      ? encryptSecret(
          JSON.stringify({ permissions: input.installation.permissions }),
          this.encryptionKey(),
        )
      : null;

    const row = await this.prisma.gitHubAppInstallation.upsert({
      where: { workspaceId: input.workspaceId },
      create: {
        workspaceId: input.workspaceId,
        installationId: String(input.installation.id),
        accountLogin: login,
        accountType,
        repositorySelection: input.installation.repository_selection ?? null,
        status,
        metadataCiphertext,
        installedByUserId: input.installedByUserId ?? null,
      },
      update: {
        installationId: String(input.installation.id),
        accountLogin: login,
        accountType,
        repositorySelection: input.installation.repository_selection ?? null,
        status,
        metadataCiphertext,
        installedByUserId: input.installedByUserId ?? undefined,
      },
    });

    return {
      appConfigured: true,
      connected: row.status === 'active',
      installationId: row.installationId,
      accountLogin: row.accountLogin,
      accountType: row.accountType,
      repositorySelection: row.repositorySelection,
      status: row.status as GitHubAppInstallationStatus,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async markInstallationRemoved(installationId: string): Promise<void> {
    const row = await this.prisma.gitHubAppInstallation.findUnique({
      where: { installationId },
    });
    if (!row) {
      return;
    }

    await this.appTokens.revokeCachedInstallationToken(installationId);
    await this.prisma.gitHubAppInstallation.update({
      where: { id: row.id },
      data: { status: 'removed' },
    });
  }

  async markInstallationSuspended(installationId: string, suspended: boolean): Promise<void> {
    const row = await this.prisma.gitHubAppInstallation.findUnique({
      where: { installationId },
    });
    if (!row) {
      return;
    }

    if (suspended) {
      await this.appTokens.revokeCachedInstallationToken(installationId);
    }

    await this.prisma.gitHubAppInstallation.update({
      where: { id: row.id },
      data: { status: suspended ? 'suspended' : 'active' },
    });
  }

  async disconnectWorkspace(workspaceId: string): Promise<void> {
    const row = await this.prisma.gitHubAppInstallation.findUnique({
      where: { workspaceId },
    });
    if (!row) {
      throw new NotFoundException('GitHub App is not connected for this workspace.');
    }

    await this.appTokens.revokeCachedInstallationToken(row.installationId);

    if (this.appTokens.isAppAuthEnabled()) {
      await this.requestGitHubUninstall(row.installationId);
    }

    await this.prisma.gitHubAppInstallation.update({
      where: { id: row.id },
      data: { status: 'removed' },
    });
  }

  async getWorkspaceIdForInstallation(installationId: string): Promise<string | null> {
    const row = await this.prisma.gitHubAppInstallation.findUnique({
      where: { installationId },
      select: { workspaceId: true, status: true },
    });
    if (!row || row.status === 'removed') {
      return null;
    }
    return row.workspaceId;
  }

  async getActiveInstallationId(workspaceId: string): Promise<string | null> {
    const row = await this.prisma.gitHubAppInstallation.findUnique({
      where: { workspaceId },
      select: { installationId: true, status: true },
    });
    if (!row || row.status !== 'active') {
      return null;
    }
    return row.installationId;
  }

  private async requestGitHubUninstall(installationId: string): Promise<void> {
    const jwt = this.appTokens.createAppJwt();
    const url = `https://api.github.com/app/installations/${encodeURIComponent(installationId)}`;

    try {
      await fetch(url, {
        method: 'DELETE',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${jwt}`,
          'User-Agent': 'Project-X',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
    } catch {
      // Best-effort — local disconnect still applies.
    }
  }

  private assertAppConfigured(): void {
    if (!this.appTokens.isAppAuthEnabled()) {
      throw new BadRequestException(
        'GitHub App integration is not configured on this server. Contact your administrator.',
      );
    }
  }

  private encryptionKey(): string {
    return this.config.getOrThrow('secrets.encryptionKey', { infer: true });
  }
}
