import { Injectable, ServiceUnavailableException } from '@nestjs/common';

import { GithubAppTokenService } from './github-app-token.service';

export type GitHubAppInstallationApi = {
  id: number;
  account?: { login?: string; type?: string };
  repository_selection?: string;
  permissions?: Record<string, string>;
  suspended_at?: string | null;
};

@Injectable()
export class GithubAppApiClient {
  constructor(private readonly appTokens: GithubAppTokenService) {}

  async fetchInstallation(installationId: string): Promise<GitHubAppInstallationApi> {
    const jwt = this.appTokens.createAppJwt();
    const url = `https://api.github.com/app/installations/${encodeURIComponent(installationId)}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${jwt}`,
          'User-Agent': 'Project-X',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
    } catch {
      throw new ServiceUnavailableException('Unable to reach GitHub to load the installation.');
    }

    const body = (await response.json().catch(() => ({}))) as GitHubAppInstallationApi & {
      message?: string;
    };
    if (!response.ok || typeof body.id !== 'number') {
      throw new ServiceUnavailableException(
        body.message ?? `GitHub installation lookup failed (HTTP ${response.status}).`,
      );
    }

    return body;
  }
}
