import { describe, expect, it } from 'vitest';

const ALLOWED_MESSAGE_TYPES = new Set(['PING']);

function acceptExtensionMessage(message: unknown, senderId: string | undefined, runtimeId: string) {
  if (senderId && senderId !== runtimeId) {
    return false;
  }
  if (!message || typeof message !== 'object') {
    return false;
  }
  const typed = message as { type?: unknown; action?: unknown; payload?: unknown };
  if (typeof typed.type !== 'string' || !ALLOWED_MESSAGE_TYPES.has(typed.type)) {
    return false;
  }
  return true;
}

describe('Day 29 extension message validation', () => {
  const runtimeId = 'abcdefghijklmnopqrstuvwxyz123456';

  it('accepts PING from same extension', () => {
    expect(acceptExtensionMessage({ type: 'PING' }, runtimeId, runtimeId)).toBe(true);
  });

  it('rejects unknown / privileged fake actions', () => {
    expect(
      acceptExtensionMessage(
        { type: 'GITHUB_WRITE', payload: { approve: true } },
        runtimeId,
        runtimeId,
      ),
    ).toBe(false);
    expect(
      acceptExtensionMessage({ action: 'billing.upgrade', payload: {} }, runtimeId, runtimeId),
    ).toBe(false);
    expect(acceptExtensionMessage({ type: 'PING' }, 'evil-extension-id', runtimeId)).toBe(false);
    expect(acceptExtensionMessage(null, runtimeId, runtimeId)).toBe(false);
    expect(
      acceptExtensionMessage({ type: 'PING', __proto__: { polluted: true } }, runtimeId, runtimeId),
    ).toBe(true); // type allowlisted; privileged dispatch still impossible
  });
});
