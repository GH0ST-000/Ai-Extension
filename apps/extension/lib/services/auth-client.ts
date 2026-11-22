import type { AuthTokenResponse, LoginRequest, RegisterRequest } from '@project-x/types';

import { clearCurrentWorkspaceId } from '../workspace/current-workspace-id';
import { clearSession, getAccessToken, setSession } from './auth-storage';

function getApiBaseUrl(): string {
  const configured = process.env.PLASMO_PUBLIC_API_URL?.trim();
  return (configured && configured.length > 0 ? configured : 'http://localhost:3001').replace(
    /\/$/,
    '',
  );
}

export class AuthClientError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = 'AuthClientError';
    this.statusCode = statusCode;
  }
}

async function parseErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string | string[] };
    if (Array.isArray(body.message)) {
      return body.message.join(', ');
    }
    if (typeof body.message === 'string' && body.message.trim()) {
      return body.message;
    }
  } catch {
    // ignore
  }
  return 'Authentication failed.';
}

async function postAuth(
  path: '/auth/login' | '/auth/register',
  body: LoginRequest | RegisterRequest,
): Promise<AuthTokenResponse> {
  const response = await fetch(`${getApiBaseUrl()}/api${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Project-X-Client': 'extension',
    },
    body: JSON.stringify(body),
    // Accept Set-Cookie from the API so the dashboard shares this session.
    credentials: 'include',
  });

  if (!response.ok) {
    throw new AuthClientError(await parseErrorMessage(response), response.status);
  }

  const result = (await response.json()) as AuthTokenResponse;
  if (!result.accessToken || !result.user) {
    throw new AuthClientError('Authentication response missing tokens.', 500);
  }
  await setSession(result.accessToken, result.user, result.refreshToken, {
    accessMaxAgeSeconds: result.expiresIn,
  });
  return result;
}

export async function login(input: LoginRequest): Promise<AuthTokenResponse> {
  return postAuth('/auth/login', input);
}

export async function register(input: RegisterRequest): Promise<AuthTokenResponse> {
  return postAuth('/auth/register', input);
}

export type EmailVerificationResendStatus =
  'sent' | 'already_verified' | 'throttled' | 'mail_not_configured' | 'mail_failed';

/**
 * Decision 1: ask the API to e-mail a new verification link to the signed-in account. Bearer
 * only (no cookies), like every other extension API call. Never throws for API outcomes.
 */
export async function resendEmailVerification(): Promise<EmailVerificationResendStatus | 'error'> {
  const token = await getAccessToken().catch(() => null);
  if (!token) return 'error';
  try {
    const response = await fetch(`${getApiBaseUrl()}/api/auth/email-verification/resend`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-Project-X-Client': 'extension',
      },
      body: '{}',
      credentials: 'omit',
    });
    if (response.status === 429) return 'throttled';
    if (!response.ok) return 'error';
    const body = (await response.json()) as { status?: EmailVerificationResendStatus };
    return body.status ?? 'error';
  } catch {
    return 'error';
  }
}

export function resendStatusMessage(status: EmailVerificationResendStatus | 'error'): string {
  switch (status) {
    case 'sent':
      return 'Verification email sent. Open the link, then retry.';
    case 'already_verified':
      return 'Your email is already confirmed. Retry the action.';
    case 'throttled':
      return 'A link was sent recently. Check your inbox (and spam), or try again in a minute.';
    default:
      return 'We could not send the email right now. Try again later.';
  }
}

export async function signOut(): Promise<void> {
  const token = await getAccessToken().catch(() => null);
  try {
    await fetch(`${getApiBaseUrl()}/api/auth/logout`, {
      method: 'POST',
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'Content-Type': 'application/json',
        'X-Project-X-Client': 'extension',
      },
      body: '{}',
      credentials: 'include',
    });
  } catch {
    // Always clear local session.
  }
  await clearSession();
  await clearCurrentWorkspaceId();
}
