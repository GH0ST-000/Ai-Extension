import { describe, expect, it } from 'vitest';

import { redactUrlForLog } from './redact-url';

describe('redactUrlForLog (M3)', () => {
  it('replaces the invitation token in the accept URL', () => {
    const token = 'Zx9_secret-token_value';
    const out = redactUrlForLog(`/api/workspace-invitations/${token}/accept`);
    expect(out).toBe('/api/workspace-invitations/[redacted]/accept');
    expect(out).not.toContain(token);
  });

  it('drops query strings and leaves other paths unchanged', () => {
    expect(redactUrlForLog('/api/workspaces/ws_1/members?x=secret')).toBe(
      '/api/workspaces/ws_1/members',
    );
    expect(redactUrlForLog('/api/workspaces/ws_1/invitations/inv_1')).toBe(
      '/api/workspaces/ws_1/invitations/inv_1',
    );
    expect(redactUrlForLog(undefined)).toBeUndefined();
  });
});
