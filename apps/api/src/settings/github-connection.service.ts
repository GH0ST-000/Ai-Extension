import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { GitHubConnectionStatus } from '@project-x/types';

import { decryptSecret, encryptSecret, isUnboundCiphertext } from '../common/crypto/secret-box';

/** F-29: where a stored GitHub token lives — the encryption context of that row. */
export const githubConnectionContext = (userId: string): string => `github_connection:${userId}`;
import { PrismaService } from '../prisma/prisma.service';

type GitHubUserResponse = {
  id?: number;
  login?: string;
  message?: string;
};

@Injectable()
export class GithubConnectionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async getStatus(userId: string): Promise<GitHubConnectionStatus> {
    const row = await this.prisma.gitHubConnection.findUnique({
      where: { userId },
    });
    if (!row) {
      return { connected: false };
    }

    return {
      connected: true,
      githubLogin: row.githubLogin,
      githubUserId: row.githubUserId,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async upsertToken(userId: string, token: string): Promise<GitHubConnectionStatus> {
    const trimmed = token.trim();
    if (!trimmed) {
      throw new BadRequestException('GitHub token must not be empty.');
    }

    const profile = await this.validateToken(trimmed);
    const encryptionKey = this.getEncryptionKey();
    // F-29: bound to this user's row (cannot be decrypted from another user's row).
    const tokenCiphertext = encryptSecret(trimmed, encryptionKey, githubConnectionContext(userId));

    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found.');
    }

    const row = await this.prisma.gitHubConnection.upsert({
      where: { userId },
      create: {
        userId,
        tokenCiphertext,
        githubUserId: String(profile.id),
        githubLogin: profile.login,
      },
      update: {
        tokenCiphertext,
        githubUserId: String(profile.id),
        githubLogin: profile.login,
      },
    });

    return {
      connected: true,
      githubLogin: row.githubLogin,
      githubUserId: row.githubUserId,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async disconnect(userId: string): Promise<void> {
    await this.prisma.gitHubConnection.deleteMany({ where: { userId } });
  }

  /**
   * Decrypt stored PAT for server-side GitHub API calls (Day 12+).
   * Never expose the return value over HTTP.
   */
  async getDecryptedToken(userId: string): Promise<string | null> {
    const row = await this.prisma.gitHubConnection.findUnique({
      where: { userId },
    });
    if (!row) {
      return null;
    }
    const token = decryptSecret(
      row.tokenCiphertext,
      this.getEncryptionKey(),
      githubConnectionContext(userId),
    );
    if (isUnboundCiphertext(row.tokenCiphertext)) {
      // Legacy value from before contextual binding: re-encrypt it bound to this row. Guarded
      // on the exact old ciphertext, so a concurrent reconnect is never overwritten.
      void this.prisma.gitHubConnection
        .updateMany({
          where: { userId, tokenCiphertext: row.tokenCiphertext },
          data: {
            tokenCiphertext: encryptSecret(
              token,
              this.getEncryptionKey(),
              githubConnectionContext(userId),
            ),
          },
        })
        .catch(() => undefined);
    }
    return token;
  }

  /**
   * Non-secret version of the stored connection: `<row id>:<updatedAt ms>`. Changes when the
   * token is replaced (upsert bumps `updatedAt`) and disappears on disconnect; a reconnect
   * gets a new row id. Never derived from the token itself.
   */
  async getConnectionVersion(userId: string): Promise<string | null> {
    const row = await this.prisma.gitHubConnection.findUnique({
      where: { userId },
      select: { id: true, updatedAt: true },
    });
    return row ? connectionVersion(row) : null;
  }

  private getEncryptionKey(): string {
    return this.config.getOrThrow<string>('secrets.encryptionKey');
  }

  private async validateToken(token: string): Promise<{ id: number; login: string }> {
    let response: Response;
    try {
      response = await fetch('https://api.github.com/user', {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'Project-X',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
    } catch {
      throw new BadRequestException('Unable to reach GitHub to validate the token.');
    }

    if (response.status === 401) {
      throw new UnauthorizedException(
        'GitHub says this token is invalid or revoked. Create a new PAT and paste it again (do not reuse a token shared in chat).',
      );
    }

    if (response.status === 403) {
      throw new UnauthorizedException(
        'GitHub forbade this token (permissions or org SSO). For fine-grained PATs enable Pull requests: Read and write on the target repos; authorize SSO if prompted.',
      );
    }

    if (!response.ok) {
      throw new BadRequestException(`GitHub token validation failed (HTTP ${response.status}).`);
    }

    const body = (await response.json()) as GitHubUserResponse;
    if (typeof body.id !== 'number' || typeof body.login !== 'string' || !body.login.trim()) {
      throw new BadRequestException('Unexpected GitHub user response.');
    }

    return { id: body.id, login: body.login };
  }
}

function connectionVersion(row: { id: string; updatedAt: Date }): string {
  return `${row.id}:${row.updatedAt.getTime()}`;
}
