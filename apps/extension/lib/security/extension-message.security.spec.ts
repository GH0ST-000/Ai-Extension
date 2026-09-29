import { describe, expect, it } from 'vitest';

import { isAllowedExtensionApiPath } from '../api/allowed-api-paths';

const ALLOWED_MESSAGE_TYPES = new Set(['PING', 'API_FETCH']);

function acceptExtensionMessage(
  message: unknown,
  senderId: string | undefined,
  runtimeId: string,
): boolean {
  if (!senderId || senderId !== runtimeId) {
    return false;
  }
  if (!message || typeof message !== 'object') {
    return false;
  }
  const typed = message as { type?: unknown; path?: unknown };
  if (typeof typed.type !== 'string' || !ALLOWED_MESSAGE_TYPES.has(typed.type)) {
    return false;
  }
  if (typed.type === 'API_FETCH') {
    return typeof typed.path === 'string' && isAllowedExtensionApiPath(typed.path);
  }
  return true;
}

describe('extension message validation', () => {
  const runtimeId = 'abcdefghijklmnopqrstuvwxyz123456';

  it('accepts PING and allowlisted API_FETCH from same extension', () => {
    expect(acceptExtensionMessage({ type: 'PING' }, runtimeId, runtimeId)).toBe(true);
    expect(
      acceptExtensionMessage({ type: 'API_FETCH', path: '/auth/me' }, runtimeId, runtimeId),
    ).toBe(true);
    expect(
      acceptExtensionMessage(
        { type: 'API_FETCH', path: '/ai/actions/stream' },
        runtimeId,
        runtimeId,
      ),
    ).toBe(true);
  });

  it('rejects missing sender id and foreign senders', () => {
    expect(acceptExtensionMessage({ type: 'PING' }, undefined, runtimeId)).toBe(false);
    expect(acceptExtensionMessage({ type: 'PING' }, 'evil-extension-id', runtimeId)).toBe(false);
  });

  it('rejects unknown / privileged fake actions and non-allowlisted paths', () => {
    expect(
      acceptExtensionMessage(
        { type: 'GITHUB_WRITE', payload: { approve: true } },
        runtimeId,
        runtimeId,
      ),
    ).toBe(false);
    expect(
      acceptExtensionMessage({ type: 'API_FETCH', path: '/admin/secrets' }, runtimeId, runtimeId),
    ).toBe(false);
    expect(
      acceptExtensionMessage({ type: 'API_FETCH', path: '../etc/passwd' }, runtimeId, runtimeId),
    ).toBe(false);
    expect(acceptExtensionMessage(null, runtimeId, runtimeId)).toBe(false);
  });
});

describe('isAllowedExtensionApiPath', () => {
  it('allows known product prefixes', () => {
    expect(isAllowedExtensionApiPath('/github/pull-requests/comments')).toBe(true);
    expect(isAllowedExtensionApiPath('/projects/acme/api/memory/summary')).toBe(true);
    expect(isAllowedExtensionApiPath('/workspaces/bootstrap')).toBe(true);
  });

  it('rejects traversal and unknown surfaces', () => {
    expect(isAllowedExtensionApiPath('/billing/admin')).toBe(false);
    expect(isAllowedExtensionApiPath('/auth/me/../../admin')).toBe(false);
    expect(isAllowedExtensionApiPath('auth/me')).toBe(false);
  });
});
