import { createHash } from 'node:crypto';

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
 * `installation:<installationId>` or `pat:<sha256 fingerprint of the token>`. It changes when
 * the workspace's installation is removed, suspended or relinked, or when the user's personal
 * token is disconnected or replaced — so anything keyed by it is invalidated at once.
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
    const resolved = await this.resolveCredential(userId, explicitWorkspaceId, true);
    return resolved ? { token: resolved.token!, source: resolved.source } : null;
  }

  /** {@link resolveApiToken} plus the identity of the credential that was used. */
  async resolveApiTokenWithIdentity(
    userId: string,
    explicitWorkspaceId?: string,
  ): Promise<(ResolvedGitHubApiToken & { identity: GitHubCredentialIdentity }) | null> {
    const resolved = await this.resolveCredential(userId, explicitWorkspaceId, true);
    return resolved
      ? { token: resolved.token!, source: resolved.source, identity: resolved.identity }
      : null;
  }

  /**
   * Identity of the credential {@link resolveApiToken} would use right now (same precedence),
   * without minting an installation token. Null when there is no usable credential.
   */
  async resolveCredentialIdentity(
    userId: string,
    explicitWorkspaceId?: string,
  ): Promise<GitHubCredentialIdentity | null> {
    return (await this.resolveCredential(userId, explicitWorkspaceId, false))?.identity ?? null;
  }

  private async resolveCredential(
    userId: string,
    explicitWorkspaceId: string | undefined,
    mint: boolean,
  ): Promise<{
    token: string | null;
    source: GitHubApiTokenSource;
    identity: GitHubCredentialIdentity;
  } | null> {
    const workspaceId = await this.resolveWorkspaceId(userId, explicitWorkspaceId);

    if (this.appTokens.isAppAuthEnabled()) {
      const installationId = await this.installations.getActiveInstallationId(workspaceId);
      if (installationId) {
        const token = mint
          ? await this.appTokens.mintInstallationAccessToken(installationId)
          : null;
        return { token, source: 'installation', identity: `installation:${installationId}` };
      }
    }

    const pat = await this.patConnections.getDecryptedToken(userId);
    if (pat) {
      return { token: pat, source: 'pat', identity: `pat:${patFingerprint(pat)}` };
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

/** One-way fingerprint of a personal token (never stored or logged in clear). */
function patFingerprint(token: string): string {
  return createHash('sha256').update(`px-github-pat:${token}`).digest('hex').slice(0, 32);
}
