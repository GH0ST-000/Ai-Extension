import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { ApiConfig } from '../config/configuration';
import { RedisService } from '../redis/redis.service';
import { createGitHubAppJwt } from './github-app-jwt';

const INSTALLATION_TOKEN_CACHE_PREFIX = 'gh:app:installation-token:';
/** GitHub tokens last 60m — cache slightly less. */
const INSTALLATION_TOKEN_CACHE_TTL_SECONDS = 50 * 60;

type InstallationTokenResponse = {
  token?: string;
  expires_at?: string;
  message?: string;
};

@Injectable()
export class GithubAppTokenService {
  constructor(
    private readonly config: ConfigService<ApiConfig, true>,
    private readonly redis: RedisService,
  ) {}

  isAppAuthEnabled(): boolean {
    return this.config.get('githubApp.enabled', { infer: true });
  }

  createAppJwt(nowMs?: number): string {
    const appId = this.config.get('githubApp.appId', { infer: true });
    const privateKeyPem = this.config.get('githubApp.privateKeyPem', { infer: true });
    return createGitHubAppJwt(appId, privateKeyPem, nowMs);
  }

  async mintInstallationAccessToken(installationId: string): Promise<string> {
    const cacheKey = `${INSTALLATION_TOKEN_CACHE_PREFIX}${installationId}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      return cached;
    }

    const jwt = this.createAppJwt();
    const url = `https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${jwt}`,
          'User-Agent': 'Project-X',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
    } catch {
      throw new ServiceUnavailableException(
        'Unable to reach GitHub to mint an installation token.',
      );
    }

    const body = (await response.json().catch(() => ({}))) as InstallationTokenResponse;
    if (!response.ok || !body.token) {
      throw new ServiceUnavailableException(
        body.message ?? `GitHub installation token request failed (HTTP ${response.status}).`,
      );
    }

    await this.redis.set(cacheKey, body.token, 'EX', INSTALLATION_TOKEN_CACHE_TTL_SECONDS);
    return body.token;
  }

  async revokeCachedInstallationToken(installationId: string): Promise<void> {
    await this.redis.del(`${INSTALLATION_TOKEN_CACHE_PREFIX}${installationId}`);
  }
}
