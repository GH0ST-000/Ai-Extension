import type {
  PrimaryGoal,
  ProfessionalRole,
  UpdateUserGrowthProfileRequest,
  UsageIntent,
  UserGrowthProfile,
} from '@project-x/types';

import { apiFetch } from './api';

/** Display labels (stored values are the stable enum ids). */
export const PROFESSIONAL_ROLE_LABELS: Record<ProfessionalRole, string> = {
  software_developer: 'Software Developer',
  tech_lead: 'Tech Lead',
  engineering_manager: 'Engineering Manager',
  qa_engineer: 'QA Engineer',
  product_owner: 'Product Owner',
  other: 'Other',
};

export const USAGE_INTENT_LABELS: Record<UsageIntent, string> = {
  personal_projects: 'Personal projects',
  team: 'Working with a team',
  exploring_ai_tools: 'Exploring AI development tools',
};

export const PRIMARY_GOAL_LABELS: Record<PrimaryGoal, string> = {
  find_bugs_earlier: 'Find bugs and risks earlier',
  faster_reviews: 'Review pull requests faster',
  enforce_standards: 'Enforce team coding standards',
  improve_code_quality: 'Improve code quality',
  just_exploring: 'Just exploring',
};

/** Shown next to the marketing checkbox; versioned as MARKETING_CONSENT_VERSION. */
export const MARKETING_CONSENT_LABEL =
  'Email me occasional product updates and tips. Optional — unsubscribe anytime.';

export function getGrowthProfile(): Promise<UserGrowthProfile> {
  return apiFetch<UserGrowthProfile>('/settings/profile');
}

export function updateGrowthProfile(
  input: UpdateUserGrowthProfileRequest,
): Promise<UserGrowthProfile> {
  return apiFetch<UserGrowthProfile>('/settings/profile', {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function skipGrowthProfile(): Promise<UserGrowthProfile> {
  return apiFetch<UserGrowthProfile>('/settings/profile/skip', { method: 'POST' });
}

export function setMarketingConsent(granted: boolean): Promise<UserGrowthProfile> {
  return apiFetch<UserGrowthProfile>('/settings/marketing-consent', {
    method: 'PUT',
    body: JSON.stringify({ granted }),
  });
}
