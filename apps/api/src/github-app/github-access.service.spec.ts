import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GithubAccessService, repositoryAccessError } from './github-access.service';

/** Mocked GitHub `GET /repos/{owner}/{repo}` as seen with the USER's own token. */
function githubRepos(answer: (url: string, auth: string) => Response) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    return answer(String(input), auth);
  });
}
const repo = (permissions: Record<string, boolean>) => Response.json({ permissions });

describe('GithubAccessService (H1)', () => {
  const prisma = {
    workspaceMembership: { findFirst: vi.fn() },
    user: { findUnique: vi.fn() },
  };
  const store = { workspaceId: 'ws_team' };
  const requestContext = { get: vi.fn() };
  const appTokens = { isAppAuthEnabled: vi.fn(), mintInstallationAccessToken: vi.fn() };
  const installations = { getActiveInstallationId: vi.fn() };
  const patConnections = {
    getDecryptedToken: vi.fn(),
    getConnectionVersion: vi.fn(),
  };
  const target = { owner: 'acme', repository: 'private-api' };

  let service: GithubAccessService;

  beforeEach(() => {
    vi.resetAllMocks();
    requestContext.get.mockReturnValue(store);
    prisma.workspaceMembership.findFirst.mockResolvedValue({
      workspaceId: 'ws_team',
      role: 'member',
    });
    appTokens.isAppAuthEnabled.mockReturnValue(true);
    appTokens.mintInstallationAccessToken.mockResolvedValue('ghs_installation_token');
    installations.getActiveInstallationId.mockResolvedValue('987654');
    patConnections.getDecryptedToken.mockResolvedValue('ghp_personal');
    service = new GithubAccessService(
      prisma as never,
      requestContext as never,
      appTokens as never,
      installations as never,
      patConnections as never,
    );
  });
  afterEach(() => vi.restoreAllMocks());

  describe('with the workspace GitHub App installed', () => {
    it('read: allowed when the user can pull — checked with the USER token, then the App token is used', async () => {
      const fetch = githubRepos(() => repo({ pull: true }));
      const result = await service.resolveRepositoryAccess('user_1', { ...target, access: 'read' });
      expect(result).toMatchObject({
        ok: true,
        token: 'ghs_installation_token',
        source: 'installation',
      });
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(String(fetch.mock.calls[0]![0])).toBe('https://api.github.com/repos/acme/private-api');
      // The App token is never the proof of the user's permission.
      expect(new Headers(fetch.mock.calls[0]![1]?.headers).get('authorization')).toBe(
        'Bearer ghp_personal',
      );
    });

    it('write: needs push; read-only users get insufficient_permission and no App token', async () => {
      githubRepos(() => repo({ pull: true, push: false }));
      expect(
        await service.resolveRepositoryAccess('user_1', { ...target, access: 'write' }),
      ).toMatchObject({
        ok: false,
        reason: 'insufficient_permission',
      });
      expect(appTokens.mintInstallationAccessToken).not.toHaveBeenCalled();
    });

    it.each([
      ['admin', { admin: true }],
      ['maintain', { maintain: true }],
      ['push', { push: true, pull: true }],
    ])('write: allowed with %s', async (_name, permissions) => {
      githubRepos(() => repo(permissions));
      expect(
        await service.resolveRepositoryAccess('user_1', { ...target, access: 'write' }),
      ).toMatchObject({
        ok: true,
      });
    });

    it.each([
      ['404 (private repository the user cannot see)', () => new Response('{}', { status: 404 })],
      ['401 (revoked personal token)', () => new Response('{}', { status: 401 })],
      ['403 (forbidden)', () => new Response('{}', { status: 403 })],
      ['no pull permission', () => repo({ pull: false })],
    ])('no access: %s', async (_name, answer) => {
      githubRepos(answer);
      expect(
        await service.resolveRepositoryAccess('user_1', { ...target, access: 'read' }),
      ).toMatchObject({
        ok: false,
        reason: 'no_access',
      });
      expect(appTokens.mintInstallationAccessToken).not.toHaveBeenCalled();
    });

    it.each([
      [
        'rate limited',
        () => new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
      ],
      ['GitHub 5xx', () => new Response('{}', { status: 502 })],
      ['missing permissions object', () => Response.json({ id: 1 })],
      [
        'network error',
        () => {
          throw new TypeError('fetch failed');
        },
      ],
    ])('fails closed when GitHub cannot answer: %s', async (_name, answer) => {
      githubRepos(answer as never);
      expect(
        await service.resolveRepositoryAccess('user_1', { ...target, access: 'read' }),
      ).toMatchObject({
        ok: false,
        reason: 'unavailable',
      });
      expect(appTokens.mintInstallationAccessToken).not.toHaveBeenCalled();
    });

    it('no personal token → identity_required; never falls back to the App token', async () => {
      patConnections.getDecryptedToken.mockResolvedValue(null);
      const fetch = githubRepos(() => repo({ pull: true }));
      expect(
        await service.resolveRepositoryAccess('user_1', { ...target, access: 'read' }),
      ).toMatchObject({
        ok: false,
        reason: 'identity_required',
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(appTokens.mintInstallationAccessToken).not.toHaveBeenCalled();
    });

    it('invalid repository names are refused without a GitHub call', async () => {
      const fetch = githubRepos(() => repo({ pull: true }));
      expect(
        await service.resolveRepositoryAccess('user_1', {
          owner: '../x',
          repository: 'y',
          access: 'read',
        }),
      ).toMatchObject({ ok: false, reason: 'no_access' });
      expect(fetch).not.toHaveBeenCalled();
    });

    it('memoized within one request only: a new request checks again (revocation applies)', async () => {
      const fetch = githubRepos(() => repo({ pull: true }));
      await service.resolveRepositoryAccess('user_1', { ...target, access: 'read' });
      await service.resolveRepositoryAccess('user_1', { ...target, access: 'read' });
      expect(fetch).toHaveBeenCalledTimes(1);
      requestContext.get.mockReturnValue({ workspaceId: 'ws_team' }); // next request
      fetch.mockImplementation(async () => new Response('{}', { status: 404 }));
      expect(
        await service.resolveRepositoryAccess('user_1', { ...target, access: 'read' }),
      ).toMatchObject({
        ok: false,
        reason: 'no_access',
      });
    });

    it('workspace membership is re-checked on every call (removed member, other workspace)', async () => {
      githubRepos(() => repo({ pull: true }));
      prisma.workspaceMembership.findFirst.mockResolvedValue(null);
      await expect(
        service.resolveRepositoryAccess('user_1', { ...target, access: 'read' }),
      ).rejects.toMatchObject({ status: 403 });
    });
  });

  it('N-1: a header workspace and an explicit workspace that disagree are refused', async () => {
    requestContext.get.mockReturnValue({ workspaceId: 'ws_header' });
    const fetch = githubRepos(() => repo({ pull: true }));
    await expect(
      service.resolveRepositoryAccess('user_1', {
        ...target,
        access: 'read',
        workspaceId: 'ws_other',
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect(fetch).not.toHaveBeenCalled();
    expect(appTokens.mintInstallationAccessToken).not.toHaveBeenCalled();
  });

  describe('without an installation', () => {
    it('uses the personal token directly (GitHub enforces access), no extra check', async () => {
      installations.getActiveInstallationId.mockResolvedValue(null);
      const fetch = githubRepos(() => repo({ pull: true }));
      expect(
        await service.resolveRepositoryAccess('user_1', { ...target, access: 'write' }),
      ).toMatchObject({
        ok: true,
        token: 'ghp_personal',
        source: 'pat',
      });
      expect(fetch).not.toHaveBeenCalled();
    });

    it('nothing connected → not_connected', async () => {
      installations.getActiveInstallationId.mockResolvedValue(null);
      patConnections.getDecryptedToken.mockResolvedValue(null);
      expect(
        await service.resolveRepositoryAccess('user_1', { ...target, access: 'read' }),
      ).toMatchObject({
        ok: false,
        reason: 'not_connected',
      });
    });
  });

  it('error mapping uses stable codes and never reveals whether a private repository exists', () => {
    expect(repositoryAccessError('no_access')).toMatchObject({ code: 'REPOSITORY_NOT_ACCESSIBLE' });
    expect(repositoryAccessError('no_access').message).toMatch(/not found, or/);
    expect(repositoryAccessError('insufficient_permission').code).toBe('INSUFFICIENT_PERMISSION');
    expect(repositoryAccessError('identity_required').code).toBe('NOT_CONNECTED');
    expect(repositoryAccessError('unavailable').code).toBe('GITHUB_UNAVAILABLE');
  });

  describe('credential identity (binds cached authorization to the credential used)', () => {
    it('installation: includes the user personal-token version; no secret involved', async () => {
      patConnections.getConnectionVersion.mockResolvedValue('conn_1:1000');
      expect(await service.resolveCredentialIdentity('user_1', 'ws_team')).toBe(
        'installation:987654|pat:conn_1:1000',
      );
      expect(appTokens.mintInstallationAccessToken).not.toHaveBeenCalled();
      expect(patConnections.getDecryptedToken).not.toHaveBeenCalled();
      // Without a personal token there is nothing to authorize with.
      patConnections.getConnectionVersion.mockResolvedValue(null);
      expect(await service.resolveCredentialIdentity('user_1', 'ws_team')).toBeNull();
    });

    it('PAT only: identity is the connection version', async () => {
      installations.getActiveInstallationId.mockResolvedValue(null);
      patConnections.getConnectionVersion.mockResolvedValue('conn_1:2000');
      expect(await service.resolveCredentialIdentity('user_1')).toBe('pat:conn_1:2000');
    });
  });
});
