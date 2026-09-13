/** Day 28 — account-level onboarding (persisted user preferences). */

export const ONBOARDING_VERSION = 1 as const;

export type OnboardingStatus = 'not_started' | 'in_progress' | 'completed' | 'dismissed';

export type FirstValueType =
  'GENERIC_AI' | 'PR_REVIEW' | 'CI_ANALYSIS' | 'JIRA_ANALYSIS' | 'OPENAPI_ANALYSIS';

export const FIRST_VALUE_TYPES = [
  'GENERIC_AI',
  'PR_REVIEW',
  'CI_ANALYSIS',
  'JIRA_ANALYSIS',
  'OPENAPI_ANALYSIS',
] as const satisfies readonly FirstValueType[];

/** Persisted preferences only — never trust client claims about GitHub/workspace. */
export interface OnboardingPreferences {
  version: number;
  welcomeSeen: boolean;
  dismissedAt: string | null;
  firstValueAt: string | null;
  firstValueType: FirstValueType | null;
  dismissedHintIds: string[];
  firstWriteEducationSeen: boolean;
}

export interface UpdateOnboardingPreferencesRequest {
  welcomeSeen?: boolean;
  dismiss?: boolean;
  /** Mark first useful action exactly once; ignored if already set. */
  firstValueType?: FirstValueType;
  /** Append-only dismissals for contextual hints. */
  dismissHintId?: string;
  firstWriteEducationSeen?: boolean;
}

export type OnboardingStepId =
  'welcome' | 'sign_in' | 'workspace' | 'connect_github' | 'try_project_x';

export interface OnboardingDerivedSteps {
  accountReady: boolean;
  workspaceReady: boolean;
  githubConnected: boolean;
  firstActionCompleted: boolean;
}

export interface OnboardingView {
  version: number;
  status: OnboardingStatus;
  preferences: OnboardingPreferences;
  steps: OnboardingDerivedSteps;
  /** Next unresolved step, or null when completed/dismissed. */
  nextStep: OnboardingStepId | null;
  /** Strongly recommended next action copy for popup/dashboard. */
  recommendedAction: {
    title: string;
    body: string;
    ctaLabel: string;
    ctaHref?: string;
  } | null;
}

export type UserFacingErrorSeverity = 'info' | 'warning' | 'error';

export type UserFacingErrorActionKind =
  | 'retry'
  | 'sign_in'
  | 'reconnect_github'
  | 'grant_repo_access'
  | 'view_plans'
  | 'switch_workspace'
  | 'refresh'
  | 'open_github'
  | 'open_settings'
  | 'copy_reference'
  | 'none';

export interface UserFacingError {
  title: string;
  message: string;
  severity: UserFacingErrorSeverity;
  code?: string;
  referenceId?: string;
  primaryAction?: {
    label: string;
    kind: UserFacingErrorActionKind;
  };
  secondaryAction?: {
    label: string;
    kind: UserFacingErrorActionKind;
  };
  detailsAvailable?: boolean;
}

/** Content-free support snapshot — never include page URL, source, tokens, or AI output. */
export interface SafeDiagnostics {
  appRelease?: string;
  extensionVersion?: string;
  client: 'extension' | 'dashboard';
  integration?: 'github' | 'jira' | 'swagger' | 'generic';
  workspacePlan?: string;
  githubConnectionState?: 'connected' | 'disconnected' | 'unknown';
  errorCode?: string;
  requestReference?: string;
  online?: boolean;
}
