import type { AuthTokenResponse, LoginRequest, RegisterRequest } from '@project-x/types';

import { clearSession, setSession } from './auth-storage';

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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new AuthClientError(await parseErrorMessage(response), response.status);
  }

  const result = (await response.json()) as AuthTokenResponse;
  await setSession(result.accessToken, result.user);
  return result;
}

export async function login(input: LoginRequest): Promise<AuthTokenResponse> {
  return postAuth('/auth/login', input);
}

export async function register(input: RegisterRequest): Promise<AuthTokenResponse> {
  return postAuth('/auth/register', input);
}

export async function signOut(): Promise<void> {
  await clearSession();
}
