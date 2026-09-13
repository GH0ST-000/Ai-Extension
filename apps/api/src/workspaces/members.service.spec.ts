import { beforeEach, describe, expect, it, vi } from 'vitest';

import { workspaceException } from './workspace.errors';
import { WorkspaceMembersService } from './members.service';

describe('WorkspaceMembersService', () => {
  const prisma = {
    workspaceMembership: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
  };

  const authorization = {
    assertAccess: vi.fn(),
    assertNotSoleOwner: vi.fn(),
  };

  let service: WorkspaceMembersService;

  beforeEach(() => {
    vi.clearAllMocks();
    authorization.assertAccess.mockResolvedValue({
      workspaceId: 'ws_1',
      membershipId: 'm_owner',
      role: 'owner',
      permissions: [],
    });
    service = new WorkspaceMembersService(prisma as never, authorization as never);
  });

  it('prevents the sole owner from demoting themselves', async () => {
    prisma.workspaceMembership.findFirst.mockResolvedValue({
      id: 'm_owner',
      workspaceId: 'ws_1',
      userId: 'user-owner',
      role: 'owner',
      status: 'active',
    });
    authorization.assertNotSoleOwner.mockRejectedValue(
      workspaceException(
        'WORKSPACE_LAST_OWNER',
        'The sole owner cannot leave or be demoted. Transfer ownership first.',
      ),
    );

    await expect(
      service.changeRole('ws_1', 'user-owner', 'm_owner', { role: 'member' }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'WORKSPACE_LAST_OWNER' }),
    });
    expect(authorization.assertNotSoleOwner).toHaveBeenCalledWith('ws_1', 'm_owner');
    expect(prisma.workspaceMembership.update).not.toHaveBeenCalled();
  });

  it('prevents the sole owner from leaving', async () => {
    prisma.workspaceMembership.findFirst.mockResolvedValue({
      id: 'm_owner',
      workspaceId: 'ws_1',
      userId: 'user-owner',
      role: 'owner',
      status: 'active',
    });
    authorization.assertNotSoleOwner.mockRejectedValue(
      workspaceException(
        'WORKSPACE_LAST_OWNER',
        'The sole owner cannot leave or be demoted. Transfer ownership first.',
      ),
    );

    await expect(service.removeMember('ws_1', 'user-owner', 'm_owner')).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'WORKSPACE_LAST_OWNER' }),
    });
    expect(authorization.assertNotSoleOwner).toHaveBeenCalledWith('ws_1', 'm_owner');
    expect(prisma.workspaceMembership.update).not.toHaveBeenCalled();
  });
});
