import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { roleHasPermission } from '@project-x/shared';
import type {
  GitHubAppInstallationStatus,
  WorkspaceGitHubAppStatus,
  WorkspaceRole,
} from '@project-x/types';

import { decryptSecret, encryptSecret } from '../common/crypto/secret-box';
import type { ApiConfig } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { GithubAppApiClient } from './github-app-api.client';
import { GithubAppTokenService } from './github-app-token.service';

const INSTALL_STATE_PREFIX = 'gh:app:install-state:';
const INSTALL_STATE_TTL_SECONDS = 15 * 60;
/** Second step: GitHub user authorization proving who may link the installation. */
const VERIFY_STATE_PREFIX = 'gh:app:verify-state:';
const VERIFY_STATE_TTL_SECONDS = 10 * 60;
const MAX_INSTALLATION_PAGES = 10;
const INSTALLATION_ID_RE = /^[1-9][0-9]{0,19}$/;
const STATE_RE = /^[a-f0-9]{48}$/;

type InstallStatePayload = {
  workspaceId: string;
  userId: string;
};

type VerifyStatePayload = InstallStatePayload & { installationId: string };

/**
 * Proof that a GitHub user who controls the installation linked it (stored encrypted in
 * `metadataCiphertext`). Installation tokens are only minted for installations carrying it.
 */
type OwnershipProof = {
  githubUserId: number;
  githubLogin: string;
  accountType: string;
  verifiedAt: string;
  linkedByUserId: string;
};

type InstallationMetadata = {
  permissions?: Record<string, string>;
  ownership?: OwnershipProof;
};

type UserInstallation = {
  id: number;
  account?: { id?: number; login?: string; type?: string };
};

/** Linking refused: the verified GitHub user is not allowed to link this installation. */
function ownershipDenied(message: string): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    code: 'GITHUB_APP_OWNERSHIP_NOT_VERIFIED',
    message,
  });
}

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
    const ownershipVerified = Boolean(this.readMetadata(row.metadataCiphertext).ownership);

    return {
      appConfigured,
      // Unverified links (made before ownership verification existed) grant nothing.
      connected: row.status === 'active' && ownershipVerified,
      ownershipVerified,
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

  /**
   * Step 2 — GitHub App Setup URL redirect. NOTHING is linked here: `installation_id` comes from
   * an unauthenticated browser redirect and proves nothing. The install state is consumed
   * (single use) and replaced by a verification state bound to the workspace, the Project X
   * user and this installation id; the browser is then sent to GitHub to authorize the App as
   * a GitHub user, whose access to the installation is checked in step 3.
   */
  async completeSetupFromCallback(input: {
    installationId: string;
    state: string;
  }): Promise<{ authorizeUrl: string }> {
    this.assertAppConfigured();
    const { clientId } = this.oauthClient();

    const installationId = input.installationId.trim();
    const state = input.state.trim();
    if (!INSTALLATION_ID_RE.test(installationId) || !STATE_RE.test(state)) {
      throw new BadRequestException('installation_id and state are required.');
    }

    const payload = await this.consumeState<InstallStatePayload>(INSTALL_STATE_PREFIX, state);
    const verifyState = randomBytes(24).toString('hex');
    const pending: VerifyStatePayload = {
      workspaceId: payload.workspaceId,
      userId: payload.userId,
      installationId,
    };
    await this.redis.set(
      `${VERIFY_STATE_PREFIX}${verifyState}`,
      JSON.stringify(pending),
      'EX',
      VERIFY_STATE_TTL_SECONDS,
    );

    const params = new URLSearchParams({
      client_id: clientId,
      state: verifyState,
      allow_signup: 'false',
    });
    return { authorizeUrl: `https://github.com/login/oauth/authorize?${params.toString()}` };
  }

  /**
   * Step 3 — completed by the signed-in Project X user (dashboard callback page → authenticated
   * endpoint), never by an anonymous redirect. Links the installation only when GitHub confirms that the
   * authorizing GitHub user controls it:
   * - user account: the installation belongs to that user;
   * - organization: the installation is accessible to the user AND the user is an org admin.
   * The installation id comes from server-side state only; the user token is used once and
   * never stored.
   */
  async completeOwnershipVerification(input: {
    code: string;
    state: string;
    /** Signed-in Project X user completing the flow (authenticated endpoint). */
    userId: string;
    /** Workspace selected by that user (WorkspaceGuard-checked). */
    workspaceId: string;
  }): Promise<WorkspaceGitHubAppStatus> {
    this.assertAppConfigured();
    const { clientId, clientSecret } = this.oauthClient();
    const code = input.code.trim();
    const state = input.state.trim();
    if (!code || code.length > 256 || !STATE_RE.test(state)) {
      throw new BadRequestException('code and state are required.');
    }
    const pending = await this.consumeState<VerifyStatePayload>(VERIFY_STATE_PREFIX, state);
    if (!INSTALLATION_ID_RE.test(pending.installationId ?? '')) {
      throw new BadRequestException('Invalid install state payload.');
    }
    // Login-CSRF / confused-deputy guard: only the Project X user who started this install,
    // in the same workspace, can complete it — a GitHub authorization obtained from someone
    // else's browser (e.g. a phishing link) is useless.
    if (pending.userId !== input.userId || pending.workspaceId !== input.workspaceId) {
      throw ownershipDenied(
        'This GitHub App verification was started by a different user or workspace.',
      );
    }
    // The person who started the install must still be allowed to manage integrations.
    await this.assertCanManageIntegrations(pending.workspaceId, pending.userId);

    const userToken = await this.exchangeOAuthCode(clientId, clientSecret, code);
    const githubUser = await this.githubUserRequest<{ id?: number; login?: string }>(
      userToken,
      '/user',
    );
    if (typeof githubUser.id !== 'number' || !githubUser.login) {
      throw ownershipDenied('GitHub did not return the authorizing user.');
    }
    const userInstallation = await this.findUserInstallation(userToken, pending.installationId);
    if (!userInstallation) {
      throw ownershipDenied('Your GitHub account cannot access this GitHub App installation.');
    }
    const account = userInstallation.account ?? {};
    if (account.type === 'User') {
      if (account.id !== githubUser.id) {
        throw ownershipDenied('Only the GitHub account that owns this installation can link it.');
      }
    } else if (account.type === 'Organization' && account.login) {
      const membership = await this.githubUserRequest<{ state?: string; role?: string }>(
        userToken,
        `/user/memberships/orgs/${encodeURIComponent(account.login)}`,
      ).catch(() => null);
      if (membership?.state !== 'active' || membership.role !== 'admin') {
        throw ownershipDenied(
          'Only an owner of this GitHub organization can link its installation.',
        );
      }
    } else {
      throw ownershipDenied('Unsupported GitHub installation account.');
    }

    const remote = await this.appApi.fetchInstallation(pending.installationId);
    if (String(remote.id) !== pending.installationId) {
      throw new BadRequestException('Installation id mismatch.');
    }
    const linkedElsewhere = await this.prisma.gitHubAppInstallation.findUnique({
      where: { installationId: pending.installationId },
      select: { workspaceId: true },
    });
    if (linkedElsewhere && linkedElsewhere.workspaceId !== pending.workspaceId) {
      throw ownershipDenied('This GitHub App installation is already linked to another workspace.');
    }

    return this.writeInstallation({
      workspaceId: pending.workspaceId,
      installedByUserId: pending.userId,
      installation: remote,
      ownership: {
        githubUserId: githubUser.id,
        githubLogin: githubUser.login,
        accountType: account.type,
        verifiedAt: new Date().toISOString(),
        linkedByUserId: pending.userId,
      },
    });
  }

  /**
   * Webhook refresh of an installation already linked to `workspaceId`. Keeps the stored
   * ownership proof for the same installation; never establishes one (a row written here
   * without proof grants no tokens).
   */
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
    const existing = await this.prisma.gitHubAppInstallation.findUnique({
      where: { workspaceId: input.workspaceId },
      select: { installationId: true, metadataCiphertext: true },
    });
    const keep =
      existing?.installationId === String(input.installation.id)
        ? this.readMetadata(existing.metadataCiphertext).ownership
        : undefined;
    return this.writeInstallation({ ...input, ...(keep ? { ownership: keep } : {}) });
  }

  private async writeInstallation(input: {
    workspaceId: string;
    installedByUserId?: string | null;
    ownership?: OwnershipProof;
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

    const metadata: InstallationMetadata = {
      ...(input.installation.permissions ? { permissions: input.installation.permissions } : {}),
      ...(input.ownership ? { ownership: input.ownership } : {}),
    };
    const metadataCiphertext =
      Object.keys(metadata).length > 0
        ? encryptSecret(JSON.stringify(metadata), this.encryptionKey())
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

    const ownershipVerified = Boolean(input.ownership);
    return {
      appConfigured: true,
      connected: row.status === 'active' && ownershipVerified,
      ownershipVerified,
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

  /**
   * The installation whose token this workspace may use: active AND linked with verified
   * GitHub ownership. Unverified links never produce installation tokens.
   */
  async getActiveInstallationId(workspaceId: string): Promise<string | null> {
    const row = await this.prisma.gitHubAppInstallation.findUnique({
      where: { workspaceId },
      select: { installationId: true, status: true, metadataCiphertext: true },
    });
    if (!row || row.status !== 'active') {
      return null;
    }
    if (!this.readMetadata(row.metadataCiphertext).ownership) {
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

  /** Atomic single-use read of a state record (GETDEL): replays and concurrent use fail. */
  private async consumeState<T>(prefix: string, state: string): Promise<T> {
    const raw = await this.redis.getdel(`${prefix}${state}`);
    if (!raw) {
      throw new BadRequestException(
        'Install session expired or invalid state. Start install again.',
      );
    }
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new BadRequestException('Invalid install state payload.');
    }
  }

  private oauthClient(): { clientId: string; clientSecret: string } {
    const clientId = this.config.get('githubApp.clientId', { infer: true });
    const clientSecret = this.config.get('githubApp.clientSecret', { infer: true });
    if (!clientId || !clientSecret) {
      throw new BadRequestException(
        'GitHub App installation verification is not configured on this server (GITHUB_APP_CLIENT_ID / GITHUB_APP_CLIENT_SECRET).',
      );
    }
    return { clientId, clientSecret };
  }

  private async assertCanManageIntegrations(workspaceId: string, userId: string): Promise<void> {
    const membership = await this.prisma.workspaceMembership.findFirst({
      where: { workspaceId, userId, status: 'active', workspace: { status: 'active' } },
      select: { role: true },
    });
    if (
      !membership ||
      !roleHasPermission(membership.role as WorkspaceRole, 'integrations:manage')
    ) {
      throw ownershipDenied('You can no longer manage integrations for this workspace.');
    }
  }

  private async exchangeOAuthCode(
    clientId: string,
    clientSecret: string,
    code: string,
  ): Promise<string> {
    let response: Response;
    try {
      response = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'Project-X',
        },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
      });
    } catch {
      throw new ServiceUnavailableException('Unable to reach GitHub to verify the installation.');
    }
    const body = (await response.json().catch(() => ({}))) as { access_token?: string };
    if (!response.ok || !body.access_token) {
      throw ownershipDenied('GitHub did not confirm your authorization. Start the install again.');
    }
    return body.access_token;
  }

  private async githubUserRequest<T>(userToken: string, path: string): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`https://api.github.com${path}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${userToken}`,
          'User-Agent': 'Project-X',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
    } catch {
      throw new ServiceUnavailableException('Unable to reach GitHub to verify the installation.');
    }
    if (!response.ok) {
      throw ownershipDenied('GitHub denied the installation ownership check.');
    }
    return (await response.json()) as T;
  }

  /** The installation as listed for the authorizing user (GET /user/installations), or null. */
  private async findUserInstallation(
    userToken: string,
    installationId: string,
  ): Promise<UserInstallation | null> {
    for (let page = 1; page <= MAX_INSTALLATION_PAGES; page += 1) {
      const body = await this.githubUserRequest<{ installations?: UserInstallation[] }>(
        userToken,
        `/user/installations?per_page=100&page=${page}`,
      );
      const list = Array.isArray(body.installations) ? body.installations : [];
      const match = list.find((i) => String(i.id) === installationId);
      if (match) return match;
      if (list.length < 100) return null;
    }
    return null;
  }

  private readMetadata(ciphertext: string | null | undefined): InstallationMetadata {
    if (!ciphertext) return {};
    try {
      const parsed = JSON.parse(
        decryptSecret(ciphertext, this.encryptionKey()),
      ) as InstallationMetadata;
      const o = parsed?.ownership;
      const validOwnership =
        o && typeof o.githubUserId === 'number' && typeof o.githubLogin === 'string';
      return {
        ...(parsed?.permissions ? { permissions: parsed.permissions } : {}),
        ...(validOwnership ? { ownership: o } : {}),
      };
    } catch {
      return {};
    }
  }

  private encryptionKey(): string {
    return this.config.getOrThrow('secrets.encryptionKey', { infer: true });
  }
}
