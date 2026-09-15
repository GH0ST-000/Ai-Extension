import type {
  FirstValueType,
  OnboardingView,
  UpdateOnboardingPreferencesRequest,
} from '@project-x/types';

import { extensionApiFetch } from '../api/background-http';
import { clearSession, getAccessToken } from '../services/auth-storage';

async function onboardingFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const accessToken = await getAccessToken();
  if (!accessToken) {
    throw new Error('Sign in required.');
  }

  const response = await extensionApiFetch(path, init);

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
