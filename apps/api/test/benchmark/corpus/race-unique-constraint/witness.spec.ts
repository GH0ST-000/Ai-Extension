import { describe, expect, it } from 'vitest';

import { fakeTable } from '../../support/fake-db';
import { inviteMember } from './head/invites.service';

type Invite = { workspaceId: string; email: string; status: string };

describe('race-unique-constraint ground truth (clean)', () => {
  it('concurrent invites for one email create exactly one row and all callers get it', async () => {
    const invite = fakeTable<Invite>([], { delayMs: 1, unique: ['workspaceId', 'email'] });
    const results = await Promise.all(
      [1, 2, 3].map(() => inviteMember({ invite }, 'ws1', 'a@example.com')),
    );
    expect(invite.rows).toHaveLength(1);
    expect(results.every((r) => r.email === 'a@example.com')).toBe(true);
  });
});
