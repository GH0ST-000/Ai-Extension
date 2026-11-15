import { describe, expect, it } from 'vitest';

import { fakeTable } from '../../support/fake-db';
import { requireSession as fixedRequire } from './fixed/session.guard';
import { requireSession as headRequire } from './head/session.guard';

const db = () => ({
  session: fakeTable([{ token: 't1', userId: 'u1', expiresAt: Date.now() - 60_000 }]),
});

describe('defensive-guard-bug ground truth', () => {
  it('an expired session is accepted', async () => {
    await expect(headRequire(db(), 't1')).resolves.toMatchObject({ userId: 'u1' });
    await expect(fixedRequire(db(), 't1')).rejects.toThrow('UNAUTHORIZED');
  });
});
