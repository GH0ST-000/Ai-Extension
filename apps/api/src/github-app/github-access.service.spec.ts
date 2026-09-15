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
});
