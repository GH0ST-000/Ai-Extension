import { Injectable } from '@nestjs/common';

import { RequestContextService } from '../observability/request-context.service';
import { PrismaService } from '../prisma/prisma.service';
import { resolveWorkspaceIdForUser } from '../workspaces/resolve-workspace-id';
import { GithubConnectionService } from '../settings/github-connection.service';
import { GithubAppInstallationService } from './github-app-installation.service';
import { GithubAppTokenService } from './github-app-token.service';

export type GitHubApiTokenSource = 'installation' | 'pat';

export type ResolvedGitHubApiToken = {
  token: string;
  source: GitHubApiTokenSource;
};

/**
 * Resolves GitHub API credentials for server-side calls.
 * Prefers workspace GitHub App installation tokens; falls back to the acting user's PAT.
 */
@Injectable()
export class GithubAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly requestContext: RequestContextService,
    private readonly appTokens: GithubAppTokenService,
    private readonly installations: GithubAppInstallationService,
    private readonly patConnections: GithubConnectionService,
  ) {}

  async resolveApiToken(
    userId: string,
    explicitWorkspaceId?: string,
  ): Promise<ResolvedGitHubApiToken | null> {
    const workspaceId = await this.resolveWorkspaceId(userId, explicitWorkspaceId);

    if (this.appTokens.isAppAuthEnabled()) {
      const installationId = await this.installations.getActiveInstallationId(workspaceId);
      if (installationId) {
        const token = await this.appTokens.mintInstallationAccessToken(installationId);
        return { token, source: 'installation' };
      }
    }

    const pat = await this.patConnections.getDecryptedToken(userId);
    if (pat) {
      return { token: pat, source: 'pat' };
    }

    return null;
  }

  /** @deprecated Prefer {@link resolveApiToken} — kept for tests migrating off PAT-only. */
  async getDecryptedToken(userId: string): Promise<string | null> {
    const resolved = await this.resolveApiToken(userId);
    return resolved?.token ?? null;
  }

  private async resolveWorkspaceId(userId: string, explicitWorkspaceId?: string): Promise<string> {
    const fromHeader = this.requestContext.get()?.workspaceId;
    if (fromHeader) {
      return resolveWorkspaceIdForUser(this.prisma, userId, fromHeader);
    }
    return resolveWorkspaceIdForUser(this.prisma, userId, explicitWorkspaceId);
  }
}
