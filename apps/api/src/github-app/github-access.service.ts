import { Injectable } from '@nestjs/common';

import { RequestContextService } from '../observability/request-context.service';
import { PrismaService } from '../prisma/prisma.service';
import { resolveWorkspaceIdForUser } from '../workspaces/resolve-workspace-id';
import { workspaceException } from '../workspaces/workspace.errors';
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
 * - read: reads (diff, files, CI, history, memory).
 * - comment: PR comments and COMMENT reviews. Readers may comment on GitHub, but through the
 *   workspace App the comment is posted as the organization's bot (N-17): on a PUBLIC
 *   repository every GitHub user can read, so the App path requires write there.
 * - write: pushes, REQUEST_CHANGES.
 */
export type RepositoryAccessLevel = 'read' | 'comment' | 'write';

/** Why a repository credential was refused (mapped to stable API error codes by callers). */
export type RepositoryAccessDenial =
  /** No credential at all (no App installation, no personal token). */
  | 'not_connected'
  /** The workspace App is installed but the user has no verified GitHub identity. */
  | 'identity_required'
  /** The user's own GitHub account cannot see the repository (or it does not exist). */
  | 'no_access'
  /** The user can read the repository but the operation needs write (push) access. */
  | 'insufficient_permission'
  /** GitHub could not be asked; fail closed. */
  | 'unavailable';

export type RepositoryAccessResult =
  | ({
      ok: true;
      workspaceId: string;
      /**
       * Decision C: with the workspace App (source 'installation'), the acting user's verified
       * GitHub login (from their own connected token) — used to attribute App-posted writes.
       */
      actorGithubLogin?: string | null;
    } & ResolvedGitHubApiToken)
  | { ok: false; reason: RepositoryAccessDenial; workspaceId: string };

type PersonalPermission =
  { level: 'none' } | { level: 'unavailable' } | { level: 'read' | 'write'; isPublic: boolean };

const PERMISSION_CHECK_TIMEOUT_MS = 10_000;

/**
 * Resolves GitHub API credentials for server-side calls (H1).
 *
 * The workspace GitHub App installation token never grants a user more than their own GitHub
 * account can do. When an installation is used, the acting user's repository permission is
 * verified first with THEIR OWN connected token (`GET /repos/{owner}/{repo}` → `permissions`),
 * never with the App token:
 *   - read operations (diffs, files, CI, comments, COMMENT reviews) need `pull`;
 *   - write operations (patch commits, REQUEST_CHANGES) need `push`.
 * A user without a connected personal token has no verified GitHub identity and is refused
 * (there is no fallback to the App token). Errors, rate limits and timeouts fail closed.
 * Without an installation the user's own token is used and GitHub enforces access itself.
 *
 * Results are memoized for the current request only (a PR review makes many reads of the same
 * repository); there is no cross-request cache, so revoked access takes effect on the next
 * request. Workspace membership/status is re-checked on every call.
 */
@Injectable()
export class GithubAccessService {
  private readonly perRequest = new WeakMap<object, Map<string, Promise<PersonalPermission>>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly requestContext: RequestContextService,
    private readonly appTokens: GithubAppTokenService,
    private readonly installations: GithubAppInstallationService,
    private readonly patConnections: GithubConnectionService,
  ) {}

  /** Credential for one repository operation, or the reason it is refused. */
  async resolveRepositoryAccess(
    userId: string,
    input: {
      owner: string;
      repository: string;
      access: RepositoryAccessLevel;
      workspaceId?: string;
    },
  ): Promise<RepositoryAccessResult> {
    const workspaceId = await this.resolveWorkspaceId(userId, input.workspaceId);

    if (this.appTokens.isAppAuthEnabled()) {
      const installationId = await this.installations.getActiveInstallationId(workspaceId);
      if (installationId) {
        const personal = await this.patConnections.getDecryptedToken(userId);
        if (!personal) return { ok: false, reason: 'identity_required', workspaceId };
        const permission = await this.personalPermission(
          userId,
          personal,
          input.owner,
          input.repository,
        );
        if (permission.level === 'unavailable') {
          return { ok: false, reason: 'unavailable', workspaceId };
        }
        if (permission.level === 'none') return { ok: false, reason: 'no_access', workspaceId };
        const needsWrite =
          input.access === 'write' || (input.access === 'comment' && permission.isPublic);
        if (needsWrite && permission.level !== 'write') {
          return { ok: false, reason: 'insufficient_permission', workspaceId };
        }
        const token = await this.appTokens.mintInstallationAccessToken(installationId);
        // Decision C: for writes, the user's CURRENT GitHub login, asked from GitHub with
        // their own token (a renamed account is never attributed under its old name).
        const actorGithubLogin =
          input.access === 'read' ? null : await fetchCurrentGithubLogin(personal);
        return { ok: true, token, source: 'installation', workspaceId, actorGithubLogin };
      }
    }

    const pat = await this.patConnections.getDecryptedToken(userId);
    if (!pat) return { ok: false, reason: 'not_connected', workspaceId };
    return { ok: true, token: pat, source: 'pat', workspaceId };
  }

  /**
   * The user's own personal token — for checks that must reflect the user's access, never the
   * workspace App's (e.g. downstream-impact consumer visibility).
   */
  async getPersonalToken(userId: string): Promise<string | null> {
    return this.patConnections.getDecryptedToken(userId);
  }

  /**
   * Identity of the credential an access decision depends on right now. Never touches a
   * secret. With an installation it includes the user's personal-token version too (access
   * is decided by the user's own GitHub permission), so caches keyed by it are per-user and
   * invalidated when either changes. Null when there is no usable credential.
   */
  async resolveCredentialIdentity(
    userId: string,
    explicitWorkspaceId?: string,
  ): Promise<GitHubCredentialIdentity | null> {
    const workspaceId = await this.resolveWorkspaceId(userId, explicitWorkspaceId);
    const version = await this.patConnections.getConnectionVersion(userId);

    if (this.appTokens.isAppAuthEnabled()) {
      const installationId = await this.installations.getActiveInstallationId(workspaceId);
      if (installationId) {
        return version ? `installation:${installationId}|pat:${version}` : null;
      }
    }

    return version ? `pat:${version}` : null;
  }

  private personalPermission(
    userId: string,
    token: string,
    owner: string,
    repository: string,
  ): Promise<PersonalPermission> {
    const store = this.requestContext.get();
    const key = `${userId}:${owner.toLowerCase()}/${repository.toLowerCase()}`;
    const memo = store ? (this.perRequest.get(store) ?? new Map()) : null;
    if (store && memo && !this.perRequest.has(store)) this.perRequest.set(store, memo);
    const cached = memo?.get(key);
    if (cached) return cached;
    const pending = fetchPersonalPermission(token, owner, repository);
    memo?.set(key, pending);
    return pending;
  }

  /**
   * The acting workspace: active membership in an active workspace with workflow:execute
   * (N-1). An explicit workspace and the X-Workspace-Id header must agree — a mismatch is
   * refused instead of silently using one of them.
   */
  private async resolveWorkspaceId(userId: string, explicitWorkspaceId?: string): Promise<string> {
    const fromHeader = this.requestContext.get()?.workspaceId;
    const explicit = explicitWorkspaceId?.trim() || undefined;
    if (fromHeader && explicit && fromHeader !== explicit) {
      throw workspaceException(
        'WORKSPACE_CONTEXT_UNAVAILABLE',
        'The selected workspace does not match this request. Refresh your workspace selection and try again.',
      );
    }
    return resolveWorkspaceIdForUser(
      this.prisma,
      userId,
      explicit ?? fromHeader,
      'workflow:execute',
    );
  }
}

/** The login GitHub reports for the user's own token right now; null when it cannot say. */
async function fetchCurrentGithubLogin(token: string): Promise<string | null> {
  try {
    const response = await fetch('https://api.github.com/user', {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'project-x-api',
      },
      signal: AbortSignal.timeout(PERMISSION_CHECK_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { login?: unknown };
    return typeof body.login === 'string' ? body.login : null;
  } catch {
    return null;
  }
}

/** The user's permission on a repository, asked with the user's own token. */
async function fetchPersonalPermission(
  token: string,
  owner: string,
  repository: string,
): Promise<PersonalPermission> {
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repository)) {
    return { level: 'none' };
  }
  try {
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'project-x-api',
        },
        signal: AbortSignal.timeout(PERMISSION_CHECK_TIMEOUT_MS),
      },
    );
    if (response.status === 404 || response.status === 401) return { level: 'none' };
    if (response.status === 429) return { level: 'unavailable' };
    if (response.status === 403) {
      // Primary or secondary rate limiting is not a permission answer; any other 403 is
      // "no access".
      const limited =
        response.headers.get('x-ratelimit-remaining') === '0' ||
        response.headers.has('retry-after');
      return { level: limited ? 'unavailable' : 'none' };
    }
    if (!response.ok) return { level: 'unavailable' };
    const body = (await response.json()) as {
      private?: boolean;
      visibility?: string;
      permissions?: { admin?: boolean; maintain?: boolean; push?: boolean; pull?: boolean };
    };
    const p = body.permissions;
    if (!p) return { level: 'unavailable' }; // no permissions object: cannot decide, fail closed
    // Unknown visibility counts as public (the stricter rule for App-posted comments).
    const isPublic = body.private !== true || body.visibility === 'public';
    if (p.admin || p.maintain || p.push) return { level: 'write', isPublic };
    return p.pull ? { level: 'read', isPublic } : { level: 'none' };
  } catch {
    return { level: 'unavailable' };
  }
}

/**
 * Stable API error for a refused repository credential. Messages never reveal whether a
 * private repository exists ("not found or no access").
 */
export function repositoryAccessError(reason: RepositoryAccessDenial): {
  code:
    | 'NOT_CONNECTED'
    | 'REPOSITORY_NOT_ACCESSIBLE'
    | 'INSUFFICIENT_PERMISSION'
    | 'GITHUB_UNAVAILABLE';
  message: string;
} {
  switch (reason) {
    case 'not_connected':
      return { code: 'NOT_CONNECTED', message: 'Connect a GitHub token in dashboard Settings.' };
    case 'identity_required':
      return {
        code: 'NOT_CONNECTED',
        message:
          'This workspace uses the Project X GitHub App. Connect your own GitHub token in dashboard Settings so Project X can confirm your access to this repository.',
      };
    case 'no_access':
      return {
        code: 'REPOSITORY_NOT_ACCESSIBLE',
        message: 'Repository not found, or your GitHub account does not have access to it.',
      };
    case 'insufficient_permission':
      return {
        code: 'INSUFFICIENT_PERMISSION',
        message: 'Your GitHub account needs write access to this repository for this action.',
      };
    case 'unavailable':
      return {
        code: 'GITHUB_UNAVAILABLE',
        message: 'Unable to verify your GitHub access right now. Try again shortly.',
      };
  }
}
