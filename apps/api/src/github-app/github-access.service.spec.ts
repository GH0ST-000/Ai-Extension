import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GithubAccessService } from './github-access.service';

describe('GithubAccessService', () => {
  const prisma = {
    workspaceMembership: { findFirst: vi.fn() },
    user: { findUnique: vi.fn() },
  };
  const requestContext = { get: vi.fn() };
  const appTokens = {
    isAppAuthEnabled: vi.fn(),
    mintInstallationAccessToken: vi.fn(),
  };
  const installations = { getActiveInstallationId: vi.fn() };
  const patConnections = {
    getDecryptedToken: vi.fn(),
    getConnectionVersion: vi.fn(),
    getDecryptedTokenWithVersion: vi.fn(),
  };

  let service: GithubAccessService;

  beforeEach(() => {
    vi.resetAllMocks();
    requestContext.get.mockReturnValue({ workspaceId: 'ws_team' });
    prisma.workspaceMembership.findFirst.mockResolvedValue({ workspaceId: 'ws_team' });
    appTokens.isAppAuthEnabled.mockReturnValue(true);
    service = new GithubAccessService(
      prisma as never,
      requestContext as never,
      appTokens as never,
      installations as never,
      patConnections as never,
    );
  });

  it('prefers installation token when workspace app is connected', async () => {
    installations.getActiveInstallationId.mockResolvedValue('987654');
    appTokens.mintInstallationAccessToken.mockResolvedValue('ghs_installation_token');

    const resolved = await service.resolveApiToken('user_1');

    expect(resolved).toEqual({ token: 'ghs_installation_token', source: 'installation' });
    expect(patConnections.getDecryptedToken).not.toHaveBeenCalled();
  });

  it('falls back to PAT when installation is revoked', async () => {
    installations.getActiveInstallationId.mockResolvedValue(null);
    patConnections.getDecryptedToken.mockResolvedValue('ghp_personal');

    const resolved = await service.resolveApiToken('user_1');

    expect(resolved).toEqual({ token: 'ghp_personal', source: 'pat' });
    expect(appTokens.mintInstallationAccessToken).not.toHaveBeenCalled();
  });

  it('returns null when neither app nor PAT is available', async () => {
    installations.getActiveInstallationId.mockResolvedValue(null);
    patConnections.getDecryptedToken.mockResolvedValue(null);

    const resolved = await service.resolveApiToken('user_1');

    expect(resolved).toBeNull();
  });

  describe('credential identity (binds cached authorization to the credential used)', () => {
    it('installation: identified by installation id, without minting a token', async () => {
      installations.getActiveInstallationId.mockResolvedValue('987654');
      expect(await service.resolveCredentialIdentity('user_1', 'ws_team')).toBe(
        'installation:987654',
      );
      expect(appTokens.mintInstallationAccessToken).not.toHaveBeenCalled();
      appTokens.mintInstallationAccessToken.mockResolvedValue('ghs_x');
      expect(await service.resolveApiTokenWithIdentity('user_1', 'ws_team')).toEqual({
        token: 'ghs_x',
        source: 'installation',
        identity: 'installation:987654',
      });
    });

    it('PAT: identity is the connection version — never derived from the token', async () => {
      installations.getActiveInstallationId.mockResolvedValue(null);
      patConnections.getConnectionVersion.mockResolvedValue('conn_1:1000');
      expect(await service.resolveCredentialIdentity('user_1')).toBe('pat:conn_1:1000');
      // Identity-only resolution never decrypts the token.
      expect(patConnections.getDecryptedToken).not.toHaveBeenCalled();
      expect(patConnections.getDecryptedTokenWithVersion).not.toHaveBeenCalled();

      patConnections.getDecryptedTokenWithVersion.mockResolvedValue({
        token: 'ghp_secret_value',
        version: 'conn_1:1000',
      });
      const resolved = await service.resolveApiTokenWithIdentity('user_1');
      expect(resolved).toEqual({
        token: 'ghp_secret_value',
        source: 'pat',
        identity: 'pat:conn_1:1000',
      });
      expect(resolved!.identity).not.toContain('ghp_secret_value');

      // Replaced token → new version; disconnected → no identity.
      patConnections.getConnectionVersion.mockResolvedValue('conn_1:2000');
      expect(await service.resolveCredentialIdentity('user_1')).toBe('pat:conn_1:2000');
      patConnections.getConnectionVersion.mockResolvedValue(null);
      expect(await service.resolveCredentialIdentity('user_1')).toBeNull();
    });

    it('same precedence as resolveApiToken: installation removed → PAT identity; nothing → null', async () => {
      installations.getActiveInstallationId.mockResolvedValue('1');
      patConnections.getConnectionVersion.mockResolvedValue('conn_1:1');
      expect(await service.resolveCredentialIdentity('user_1')).toBe('installation:1');
      installations.getActiveInstallationId.mockResolvedValue(null);
      expect(await service.resolveCredentialIdentity('user_1')).toBe('pat:conn_1:1');
      patConnections.getConnectionVersion.mockResolvedValue(null);
      expect(await service.resolveCredentialIdentity('user_1')).toBeNull();
      appTokens.isAppAuthEnabled.mockReturnValue(false);
      installations.getActiveInstallationId.mockResolvedValue('1');
      expect(await service.resolveCredentialIdentity('user_1')).toBeNull();
    });
  });
});
