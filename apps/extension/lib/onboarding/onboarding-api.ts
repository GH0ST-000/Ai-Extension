import type {
  FirstValueType,
  OnboardingView,
  UpdateOnboardingPreferencesRequest,
} from '@project-x/types';

import { applyWorkspaceHeader } from '../api/workspace';
import { clearSession, getAccessToken } from '../services/auth-storage';

function getApiBaseUrl(): string {
  const configured = process.env.PLASMO_PUBLIC_API_URL?.trim();
  return (configured && configured.length > 0 ? configured : 'http://localhost:3001').replace(
    /\/$/,
    '',
  );
}

async function onboardingFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const accessToken = await getAccessToken();
  if (!accessToken) {
    throw new Error('Sign in required.');
  }

  const headers = new Headers(init?.headers);
  if (!headers.has('Content-Type') && init?.body) {
    headers.set('Content-Type', 'application/json');
  }
  headers.set('Authorization', `Bearer ${accessToken}`);
  headers.set('Accept', 'application/json');
  await applyWorkspaceHeader(headers);

  const response = await fetch(`${getApiBaseUrl()}/api${path}`, {
    ...init,
    headers,
  });

  if (response.status === 401) {
    await clearSession();
    throw new Error('Sign in required.');
  }

  if (!response.ok) {
    throw new Error('Unable to update setup progress.');
  }

  return (await response.json()) as T;
}

export function fetchOnboarding(): Promise<OnboardingView> {
  return onboardingFetch<OnboardingView>('/settings/onboarding');
}

export function updateOnboarding(
  input: UpdateOnboardingPreferencesRequest,
): Promise<OnboardingView> {
  return onboardingFetch<OnboardingView>('/settings/onboarding', {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function markWelcomeSeen(): Promise<void> {
  try {
    await updateOnboarding({ welcomeSeen: true });
  } catch {
    // Non-blocking UX preference
  }
}

export async function dismissOnboarding(): Promise<void> {
  try {
    await updateOnboarding({ dismiss: true });
  } catch {
    // Non-blocking
  }
}

export async function markFirstValue(firstValueType: FirstValueType): Promise<void> {
  try {
    await updateOnboarding({ firstValueType });
  } catch {
    // Non-blocking — first-value is best-effort
  }
}

export async function dismissHint(hintId: string): Promise<void> {
  try {
    await updateOnboarding({ dismissHintId: hintId });
  } catch {
    // Non-blocking
  }
}

export async function markFirstWriteEducationSeen(): Promise<void> {
  try {
    await updateOnboarding({ firstWriteEducationSeen: true });
  } catch {
    // Non-blocking
  }
}
