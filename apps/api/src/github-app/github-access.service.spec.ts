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
  const patConnections = { getDecryptedToken: vi.fn() };

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

    it('PAT: a stable fingerprint that changes when the token is replaced and never contains it', async () => {
      installations.getActiveInstallationId.mockResolvedValue(null);
      patConnections.getDecryptedToken.mockResolvedValue('ghp_first_token_value');
      const first = await service.resolveCredentialIdentity('user_1');
      expect(first).toMatch(/^pat:[0-9a-f]{32}$/);
      expect(first).not.toContain('ghp_first_token_value');
      expect(await service.resolveCredentialIdentity('user_1')).toBe(first);
      patConnections.getDecryptedToken.mockResolvedValue('ghp_second_token_value');
      expect(await service.resolveCredentialIdentity('user_1')).not.toBe(first);
    });

    it('same precedence as resolveApiToken: installation removed → PAT identity; nothing → null', async () => {
      installations.getActiveInstallationId.mockResolvedValue('1');
      patConnections.getDecryptedToken.mockResolvedValue('ghp_p');
      expect(await service.resolveCredentialIdentity('user_1')).toBe('installation:1');
      installations.getActiveInstallationId.mockResolvedValue(null);
      expect(await service.resolveCredentialIdentity('user_1')).toMatch(/^pat:/);
      patConnections.getDecryptedToken.mockResolvedValue(null);
      expect(await service.resolveCredentialIdentity('user_1')).toBeNull();
      appTokens.isAppAuthEnabled.mockReturnValue(false);
      installations.getActiveInstallationId.mockResolvedValue('1');
      expect(await service.resolveCredentialIdentity('user_1')).toBeNull();
    });
  });
});
