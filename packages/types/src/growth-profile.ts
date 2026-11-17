/**
 * Optional growth profile, marketing email consent and first-touch attribution.
 *
 * Professional role is marketing / product segmentation only — it is NOT a workspace role and
 * never affects permissions or which UI a user sees. All profile fields are optional.
 */

export const PROFESSIONAL_ROLES = [
  'software_developer',
  'tech_lead',
  'engineering_manager',
  'qa_engineer',
  'product_owner',
  'other',
] as const;
export type ProfessionalRole = (typeof PROFESSIONAL_ROLES)[number];

export const USAGE_INTENTS = ['personal_projects', 'team', 'exploring_ai_tools'] as const;
export type UsageIntent = (typeof USAGE_INTENTS)[number];

export const PRIMARY_GOALS = [
  'find_bugs_earlier',
  'faster_reviews',
  'enforce_standards',
  'improve_code_quality',
  'just_exploring',
] as const;
export type PrimaryGoal = (typeof PRIMARY_GOALS)[number];

export interface UserGrowthProfile {
  professionalRole: ProfessionalRole | null;
  usageIntent: UsageIntent | null;
  primaryGoal: PrimaryGoal | null;
  /** Set when the user saved the onboarding questions. */
  profileCompletedAt: string | null;
  /** Set when the user chose "Skip for now". */
  profileSkippedAt: string | null;
  /** Marketing email consent (never required; transactional email is unaffected). */
  marketingEmailConsent: boolean;
  marketingConsentUpdatedAt: string | null;
}

/** Partial update: omitted = unchanged, `null` = clear. */
export interface UpdateUserGrowthProfileRequest {
  professionalRole?: ProfessionalRole | null;
  usageIntent?: UsageIntent | null;
  primaryGoal?: PrimaryGoal | null;
}

/** Version id of the marketing-consent wording shown to the user (see docs/growth-profile.md). */
export const MARKETING_CONSENT_VERSION = 'marketing-email-2026-11';

export const MARKETING_CONSENT_SOURCES = [
  'dashboard_signup',
  'extension_signup',
  'settings',
] as const;
export type MarketingConsentSource = (typeof MARKETING_CONSENT_SOURCES)[number];

/** First-touch acquisition fields accepted at registration (all optional, all untrusted). */
export interface SignupAttribution {
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  /** `ref` query parameter (e.g. a partner or campaign slug). */
  referral?: string;
  /** Host of the external page that linked to the landing page — never a full URL. */
  referrerHost?: string;
}

export const ATTRIBUTION_MAX_LENGTH = 100;
