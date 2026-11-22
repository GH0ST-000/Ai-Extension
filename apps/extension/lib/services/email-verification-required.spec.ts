/**
 * Decision 1: free AI refused with 403 EMAIL_VERIFICATION_REQUIRED is shown as an actionable
 * "confirm your email" state (not a generic provider error), offers Resend, and keeps the input
 * (the caller keeps the request and simply retries).
 */
import { AIAction, type ExecuteAiActionRequest } from '@project-x/types';
import { mapToUserFacingError } from '@project-x/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const streamMock = vi.fn();
const reportMock = vi.fn();
vi.mock('../api/background-http', () => ({
  extensionApiStream: (...args: unknown[]) => streamMock(...args),
}));
vi.mock('./auth-storage', () => ({
  hasAuthSession: async () => true,
  clearSessionStorageOnly: async () => undefined,
  getAccessToken: async () => 'access-token-for-test',
  clearSession: async () => undefined,
  setSession: async () => undefined,
}));
vi.mock('../observability/report-error', () => ({
  reportExtensionError: (...args: unknown[]) => reportMock(...args),
}));

import { AiClientError, resetUnfinishedOperations, streamAiAction } from './ai-client';
import { resendEmailVerification, resendStatusMessage } from './auth-client';

const SERVER_MESSAGE =
  'Confirm your email address to use free AI actions. Check your inbox or request a new verification link.';
const request: ExecuteAiActionRequest = { action: AIAction.EXPLAIN, text: 'Explain this' };

describe('EMAIL_VERIFICATION_REQUIRED in the extension', () => {
  beforeEach(() => {
    streamMock.mockReset();
    reportMock.mockReset();
    resetUnfinishedOperations();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('surfaces the server code and message, not the generic AI error, and is not reported as a failure', async () => {
    streamMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 'EMAIL_VERIFICATION_REQUIRED',
          message: SERVER_MESSAGE,
          statusCode: 403,
        }),
        { status: 403 },
      ),
    );
    const error = (await streamAiAction(request, { onChunk: () => undefined }).catch(
      (e: unknown) => e,
    )) as AiClientError;
    expect(error).toBeInstanceOf(AiClientError);
    expect(error.code).toBe('EMAIL_VERIFICATION_REQUIRED');
    expect(error.message).toBe(SERVER_MESSAGE);
    await new Promise((r) => setTimeout(r, 0));
    expect(reportMock).not.toHaveBeenCalled();
  });

  it('maps to a confirm-email panel with Resend as the primary action and Retry as the secondary', () => {
    const mapped = mapToUserFacingError({
      code: 'EMAIL_VERIFICATION_REQUIRED',
      message: SERVER_MESSAGE,
    });
    expect(mapped.title).toBe('Confirm your email to use free AI');
    expect(mapped.message).toBe(SERVER_MESSAGE);
    expect(mapped.primaryAction).toEqual({
      label: 'Resend verification email',
      kind: 'resend_verification',
    });
    expect(mapped.secondaryAction?.kind).toBe('retry');
  });

  it('resend uses the bearer token without cookies and reports each outcome', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    for (const status of ['sent', 'already_verified', 'throttled', 'mail_failed'] as const) {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ status }), { status: 202 }));
      expect(await resendEmailVerification()).toBe(status);
    }
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/auth\/email-verification\/resend$/);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('omit');
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer access-token-for-test',
    );
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 429 }));
    expect(await resendEmailVerification()).toBe('throttled');
    fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    expect(await resendEmailVerification()).toBe('error');
    expect(resendStatusMessage('sent')).toMatch(/sent/i);
    expect(resendStatusMessage('error')).toMatch(/could not send/i);
  });
});
