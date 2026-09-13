import type {
  FirstValueType,
  OnboardingDerivedSteps,
  OnboardingPreferences,
  OnboardingStatus,
  OnboardingStepId,
  OnboardingView,
} from '@project-x/types';
import { ONBOARDING_VERSION } from '@project-x/types';

export type BuildOnboardingViewInput = {
  authenticated: boolean;
  workspaceReady: boolean;
  githubConnected: boolean;
  preferences: OnboardingPreferences;
  /** Dashboard origin without trailing slash — for CTA hrefs. */
  dashboardBaseUrl?: string;
};

function settingsHref(base: string | undefined, path: string): string | undefined {
  if (!base) return undefined;
  return `${base.replace(/\/$/, '')}${path}`;
}

export function defaultOnboardingPreferences(
  version: number = ONBOARDING_VERSION,
): OnboardingPreferences {
  return {
    version,
    welcomeSeen: false,
    dismissedAt: null,
    firstValueAt: null,
    firstValueType: null,
    dismissedHintIds: [],
    firstWriteEducationSeen: false,
  };
}

export function deriveOnboardingSteps(input: {
  authenticated: boolean;
  workspaceReady: boolean;
  githubConnected: boolean;
  firstActionCompleted: boolean;
}): OnboardingDerivedSteps {
  return {
    accountReady: input.authenticated,
    workspaceReady: input.authenticated && input.workspaceReady,
    githubConnected: input.githubConnected,
    firstActionCompleted: input.firstActionCompleted,
  };
}

export function resolveOnboardingStatus(
  preferences: OnboardingPreferences,
  steps: OnboardingDerivedSteps,
): OnboardingStatus {
  if (preferences.dismissedAt) {
    return 'dismissed';
  }
  if (steps.accountReady && steps.workspaceReady && steps.firstActionCompleted) {
    return 'completed';
  }
  if (preferences.welcomeSeen || steps.accountReady || steps.firstActionCompleted) {
    return 'in_progress';
  }
  return 'not_started';
}

export function resolveNextOnboardingStep(
  status: OnboardingStatus,
  steps: OnboardingDerivedSteps,
  preferences: OnboardingPreferences,
): OnboardingStepId | null {
  if (status === 'completed' || status === 'dismissed') {
    return null;
  }
  if (!preferences.welcomeSeen && !steps.accountReady) {
    return 'welcome';
  }
  if (!steps.accountReady) {
    return 'sign_in';
  }
  if (!steps.workspaceReady) {
    return 'workspace';
  }
  if (!steps.firstActionCompleted) {
    // GitHub is recommended but not required for first generic value.
    if (!steps.githubConnected) {
      return 'connect_github';
    }
    return 'try_project_x';
  }
  return null;
}

export function buildRecommendedAction(input: {
  nextStep: OnboardingStepId | null;
  steps: OnboardingDerivedSteps;
  dashboardBaseUrl?: string;
}): OnboardingView['recommendedAction'] {
  const { nextStep, steps, dashboardBaseUrl } = input;
  if (!nextStep) {
    if (steps.firstActionCompleted && !steps.githubConnected) {
      return {
        title: 'Connect GitHub when you are ready',
        body: 'Review PRs, analyze CI, and apply fixes after you confirm each write.',
        ctaLabel: 'Connect GitHub',
        ctaHref: settingsHref(dashboardBaseUrl, '/app/settings'),
      };
    }
    return null;
  }

  switch (nextStep) {
    case 'welcome':
      return {
        title: 'Welcome to Project X',
        body: 'Understand, review, and act on engineering context where you work.',
        ctaLabel: 'Get Started',
      };
    case 'sign_in':
      return {
        title: 'Sign in to continue',
        body: 'Use the same account in the extension and dashboard.',
        ctaLabel: 'Sign in',
      };
    case 'workspace':
      return {
        title: 'Choose a workspace',
        body: 'Your personal workspace is ready — switch or create a team workspace anytime.',
        ctaLabel: 'Open workspace',
        ctaHref: settingsHref(dashboardBaseUrl, '/app/workspace'),
      };
    case 'connect_github':
      return {
        title: 'Connect GitHub',
        body: 'Optional for selected-text AI. Required for PR reviews, CI analysis, and confirmed writes.',
        ctaLabel: 'Connect GitHub',
        ctaHref: settingsHref(dashboardBaseUrl, '/app/settings'),
      };
    case 'try_project_x':
      return steps.githubConnected
        ? {
            title: 'Try your first review',
            body: 'Open a pull request and click Review PR — or select text anywhere and Ask AI.',
            ctaLabel: 'Open a PR',
          }
        : {
            title: 'Try Ask AI',
            body: 'Select text on any page, then choose an action. No GitHub connection required.',
            ctaLabel: 'Select text to start',
          };
    default:
      return null;
  }
}

export function buildOnboardingView(input: BuildOnboardingViewInput): OnboardingView {
  const preferences = {
    ...input.preferences,
    version: input.preferences.version || ONBOARDING_VERSION,
  };
  const steps = deriveOnboardingSteps({
    authenticated: input.authenticated,
    workspaceReady: input.workspaceReady,
    githubConnected: input.githubConnected,
    firstActionCompleted: Boolean(preferences.firstValueAt),
  });
  const status = resolveOnboardingStatus(preferences, steps);
  const nextStep = resolveNextOnboardingStep(status, steps, preferences);

  return {
    version: preferences.version,
    status,
    preferences,
    steps,
    nextStep,
    recommendedAction: buildRecommendedAction({
      nextStep,
      steps,
      dashboardBaseUrl: input.dashboardBaseUrl,
    }),
  };
}

export function firstValueTypeForAiAction(action: string): FirstValueType {
  switch (action) {
    case 'REVIEW_ENTIRE_PR':
      return 'PR_REVIEW';
    case 'ANALYZE_CI_FAILURE':
    case 'UNDERSTAND_CI_FAILURE':
      return 'CI_ANALYSIS';
    case 'SUMMARIZE_JIRA_ISSUE':
    case 'EXTRACT_ACCEPTANCE_CRITERIA':
    case 'CREATE_TECHNICAL_PLAN':
    case 'ANALYZE_JIRA_RISKS':
      return 'JIRA_ANALYSIS';
    case 'EXPLAIN_OPENAPI_OPERATION':
    case 'EXPLAIN_OPENAPI_REQUEST':
    case 'EXPLAIN_OPENAPI_RESPONSE':
    case 'GENERATE_OPENAPI_EXAMPLE':
    case 'ANALYZE_OPENAPI_CONTRACT':
      return 'OPENAPI_ANALYSIS';
    default:
      return 'GENERIC_AI';
  }
}
