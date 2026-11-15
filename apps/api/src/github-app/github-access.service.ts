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
 * Stable, non-secret identity of the credential a call would use:
 * `installation:<installationId>` or `pat:<connection row id>:<updatedAt>`. Never derived from
 * a secret. It changes when the workspace's installation is removed, suspended or relinked, or
 * when the user's personal token is disconnected, reconnected or replaced — so anything keyed by
 * it is invalidated at once.
 */
export type GitHubCredentialIdentity = string;

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

  /**
   * Identity of the credential {@link resolveApiToken} would use right now (same precedence).
   * Never touches a secret: no installation token is minted and no personal token is
   * decrypted. Null when there is no usable credential.
   */
  async resolveCredentialIdentity(
    userId: string,
    explicitWorkspaceId?: string,
  ): Promise<GitHubCredentialIdentity | null> {
    const workspaceId = await this.resolveWorkspaceId(userId, explicitWorkspaceId);

    if (this.appTokens.isAppAuthEnabled()) {
      const installationId = await this.installations.getActiveInstallationId(workspaceId);
      if (installationId) {
        return `installation:${installationId}`;
      }
    }

    const version = await this.patConnections.getConnectionVersion(userId);
    return version ? `pat:${version}` : null;
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
