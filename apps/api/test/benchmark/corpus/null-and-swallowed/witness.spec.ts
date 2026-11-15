import { describe, expect, it } from 'vitest';

import { fakeTable } from '../../support/fake-db';
import { notifyOwner as fixedNotify } from './fixed/notify';
import { notifyOwner as headNotify } from './head/notify';

type User = { workspaceId: string; role: string; email: string; displayName?: string | null };
const ok = { send: async () => undefined };
const failing = {
  send: async () => {
    throw new Error('SMTP_DOWN');
  },
};

describe('null-and-swallowed ground truth', () => {
  it('a workspace without an owner crashes', async () => {
    const db = { user: fakeTable<User>([]) };
    await expect(headNotify(db, ok, 'ws1')).rejects.toThrow(TypeError);
    await expect(fixedNotify(db, ok, 'ws1')).resolves.toEqual({ sent: false });
  });

  it('a failed send is reported as sent', async () => {
    const db = () => ({
      user: fakeTable<User>([
        { workspaceId: 'ws1', role: 'owner', email: 'o@x', displayName: 'Ann' },
      ]),
    });
    await expect(headNotify(db(), failing, 'ws1')).resolves.toEqual({ sent: true });
    await expect(fixedNotify(db(), failing, 'ws1')).rejects.toThrow('SMTP_DOWN');
  });
});
