import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { JiraConnectionStatus } from '@project-x/types';

import { decryptSecret, encryptSecret } from '../common/crypto/secret-box';
import { PrismaService } from '../prisma/prisma.service';
import { jiraSiteBaseUrl, normalizeJiraSiteHost } from './jira-site';

type JiraMyselfResponse = {
  accountId?: string;
  displayName?: string;
  emailAddress?: string;
  message?: string;
  errorMessages?: string[];
};

@Injectable()
export class JiraConnectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async getStatus(userId: string): Promise<JiraConnectionStatus> {
    const row = await this.prisma.jiraConnection.findUnique({ where: { userId } });
    if (!row) {
      return { connected: false };
    }
    return {
      connected: true,
      siteHost: row.siteHost,
      siteDisplayName: row.siteDisplayName,
      accountId: row.accountId,
      displayName: row.displayName,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async upsertConnection(
    userId: string,
    input: { email: string; apiToken: string; siteHost: string },
  ): Promise<JiraConnectionStatus> {
    const email = input.email.trim().toLowerCase();
    const apiToken = input.apiToken.trim();
    const siteHost = normalizeJiraSiteHost(input.siteHost);

    if (!email || !email.includes('@')) {
      throw new BadRequestException('A valid Atlassian account email is required.');
    }
    if (!apiToken) {
      throw new BadRequestException('Jira API token must not be empty.');
    }
    if (!siteHost) {
      throw new BadRequestException(
        'siteHost must be an HTTPS *.atlassian.net host (e.g. company.atlassian.net).',
      );
    }

    const profile = await this.validateCredentials(email, apiToken, siteHost);
    const encryptionKey = this.getEncryptionKey();
    const tokenCiphertext = encryptSecret(apiToken, encryptionKey);

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found.');
    }

    const row = await this.prisma.jiraConnection.upsert({
      where: { userId },
      create: {
        userId,
        email,
        tokenCiphertext,
        siteHost,
        siteDisplayName: siteHost.replace(/\.atlassian\.net$/i, ''),
        accountId: profile.accountId,
        displayName: profile.displayName,
      },
      update: {
        email,
        tokenCiphertext,
        siteHost,
        siteDisplayName: siteHost.replace(/\.atlassian\.net$/i, ''),
        accountId: profile.accountId,
        displayName: profile.displayName,
      },
    });

    return {
      connected: true,
      siteHost: row.siteHost,
      siteDisplayName: row.siteDisplayName,
      accountId: row.accountId,
      displayName: row.displayName,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async disconnect(userId: string): Promise<void> {
    await this.prisma.jiraConnection.deleteMany({ where: { userId } });
  }

  /**
   * Resolve credentials for server-side Jira API calls. Never expose over HTTP.
   */
  async getDecryptedCredentials(userId: string): Promise<{
    email: string;
    apiToken: string;
    siteHost: string;
  } | null> {
    const row = await this.prisma.jiraConnection.findUnique({ where: { userId } });
    if (!row) {
      return null;
    }
    return {
      email: row.email,
      apiToken: decryptSecret(row.tokenCiphertext, this.getEncryptionKey()),
      siteHost: row.siteHost,
    };
  }

  private getEncryptionKey(): string {
    return this.config.getOrThrow<string>('secrets.encryptionKey');
  }

  private basicAuthHeader(email: string, apiToken: string): string {
    return `Basic ${Buffer.from(`${email}:${apiToken}`, 'utf8').toString('base64')}`;
  }

  private async validateCredentials(
    email: string,
    apiToken: string,
    siteHost: string,
  ): Promise<{ accountId: string; displayName: string }> {
    const url = `${jiraSiteBaseUrl(siteHost)}/rest/api/3/myself`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: this.basicAuthHeader(email, apiToken),
          'User-Agent': 'Project-X',
        },
      });
    } catch {
      throw new BadRequestException('Unable to reach Jira to validate credentials.');
    }

    if (response.status === 401) {
      throw new UnauthorizedException(
        'Jira says these credentials are invalid. Use your Atlassian email and an API token (not your password).',
      );
    }
    if (response.status === 403) {
      throw new UnauthorizedException(
        'Jira forbade this account for the given site. Check site access and API token permissions.',
      );
    }
    if (!response.ok) {
      throw new BadRequestException(`Jira credential validation failed (HTTP ${response.status}).`);
    }

    const body = (await response.json()) as JiraMyselfResponse;
    if (!body.accountId?.trim() || !body.displayName?.trim()) {
      throw new BadRequestException('Unexpected Jira user response.');
    }
    return { accountId: body.accountId, displayName: body.displayName };
  }
}
